'use strict';

var EventEmitter = require('events').EventEmitter;
var Promise = require('bluebird');
var uuid = require('node-uuid');
var _ = require('lodash');

var Etcd = require('node-etcd');

/**
 * Etcd-backed authority lock.
 */
class Authoritah extends EventEmitter {    
    /**
     * @event Authoritah#acquired
     * @description Fired when lock is acquired.
     */

    /**
     * @event Authoritah#lost
     * @description
     * Fired when lock is lost, i.e. stolen or expired.
     * If lock has expired, we assume the authority is not ready and do not make any further attemps to lock.
     */
    
    /**
     * @param {string} key - The key to lock against.
     * @param {Object} options
     * @param {number} [options.ttl=15] - The time-to-live of the lock in seconds, after which it expires if not extended.
     * @param {number} [options.heartbeatInterval=2] - The number of seconds between each request to extend lock.
     * @param {Etcd} [options.etcd] - Instantiation of node-etcd class. If no instance is given, a default one is instantiated.
     */
    constructor(key, options) {
        super();

        options = _.defaults(
            options || {},
            {
                ttl: 15,
                heartbeatInterval: 2,
                etcd: new Etcd()
            }
        );

        this.etcd = Promise.promisifyAll(options.etcd);
        this.ttl = Math.ceil(options.ttl);
        this.heartbeatInterval = options.heartbeatInterval;
        
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

        /**
         * @function
         * @description A helper function for extending the lock in a throttled manner, with an interval specified in the constructor.
         * @example stream.on('readable', () => { authority.heartbeat(); });
         */
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

    /**
     * Sets authority as ready, and attempt to acquire lock.
     * If the lock is already taken, then another attempt will be made when it is released or expires.
     *
     * @returns {Promise<boolean>} A promise that will be fulfilled after lock attempt with a boolean indicating whether attempt was successful.
     */
    ready() {
        this.$ready = true;
        return this.$attemptLock();
    }

    /**
     * Releases lock if currently held, and stop making attempts to lock it.
     *
     * @returns {Promise} A promise that will be fulfilled when lock is released, or immediately when lock is not currently ours.
     */
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

    /**
     * Extends lock for another time period defined by the authority's TTL.
     * Calls #ready if authority is not marked as ready.
     * If lock is not ours at the time, this will have no effect.
     *
     * @returns {Promise} Promise that will be fulfilled when the lock is extended or acquired, or immediately if lock is currently not ours.
     */
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

module.exports = Authoritah;
