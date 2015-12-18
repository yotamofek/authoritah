'use strict';

var EventEmitter = require('events').EventEmitter;
var Promise = require('bluebird');
var uuid = require('node-uuid');
var _ = require('lodash');

var Etcd = require('node-etcd');

module.exports = class Authority extends EventEmitter {
    constructor(key, options) {
        super();

        options = _.isPlainObject(options) ? options : {};
        
        this.etcd = Promise.promisifyAll(
            options.etcd !== undefined
                ? options.etcd
                : new Etcd()
        );
        
        this.ttl = Math.ceil(options.ttl !== undefined ? options.ttl : 15);
        this.heartbeatInterval = options.heartbeatInterval !== undefined ? options.heartbeatInterval : 2;
        
        this.key = '/authoritah/locks/' + key;
        this.$id = uuid.v4();

        this.$watcher = this.etcd.watcher(this.key)
            .on('change', event => {
                switch (event.action) {
                case 'expire':
                    this.$locked = false;
                    
                    if (event.prevNode.value == this.$id) {
                        this.release();
                        this.emit('lost');
                    }
                    
                    if (this.$ready) {
                        this.$attemptLock();
                    }
                    
                    break;

                case 'delete':
                case 'compareAndDelete':
                    if (event.prevNode.value == this.$id) {
                        this.emit('lost');
                    } else if (this.$ready) {
                        this.$attemptLock();
                    }

                    break;
                }
            });

        this.heartbeat = _.throttle(this.extend.bind(this), this.heartbeatInterval * 1000);
    }

    $attemptLock() {
        return this.etcd.setAsync(
            this.key,
            this.$id,
            {
                ttl: this.ttl,
                prevExist: false
            }
        )
            .bind(this)
            .then(function() {
                this.$locked = true;
                
                this.emit('acquired');

                return true;
            })
            .catch(function(err) {
                return false;
            });
    }

    ready() {
        this.$ready = true;
        return this.$attemptLock();
    }

    release() {
        this.$ready = false;

        if (this.$locked) {
            return this.etcd.compareAndDeleteAsync(
                this.key,
                this.$id
            )
                .bind(this)
                .then(function() {
                    this.$locked = false;
                });
        } else {
            return Promise.resolve();
        }
    }

    extend() {
        if (!this.$ready) {
            return this.ready();
        }
        
        if (!this.$locked) {
            return Promise.resolve();
        }
        
        return this.etcd.setAsync(
            this.key,
            this.$id,
            {
                ttl: this.ttl,
                prevValue: this.$id
            }
        );
    }
}
