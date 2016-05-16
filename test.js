'use strict';

var Promise = require('bluebird');
var chai = require('chai');
var chaiAsPromised = require('chai-as-promised');
var _ = require('lodash');

chai.use(chaiAsPromised);
chai.should();

var Authoritah = require('./');

function eventShouldEmit(emitter, event, timeout) {
    let events = _.isArray(event) ? event : [event];

    // create a promise that is only resolved after a chain of events are fired
    let promise = _.reduce(
        events,
        (promise, event) =>
            promise.then(() => new Promise(resolve => {
                emitter.on(event, resolve);
            })),
        Promise.resolve()
    );

    return timeout === undefined
        ? promise
        : promise.timeout(timeout);
}

describe('Authoritah', function() {
    this.timeout(0);
    
    let key = 'test_key';
    
    it('should lock when lock is free', () => {
        let authority = new Authoritah(key);

        return authority.ready()
            .tap(() => authority.release());
    });

    it('should not lock when someone else has lock', () => {
        let authority = new Authoritah(key);
        let nonAuthority = new Authoritah(key);

        return authority.ready()
            .then(() => Promise.all([
                eventShouldEmit(nonAuthority, 'taken'),
                nonAuthority.ready()
            ]))
            .get(1)
            .tap(() => {
                nonAuthority.release();
                return authority.release();
            })
            .should.eventually.be.not.ok;
    });

    it('lock should timeout if not extended', () => {
        let authority = new Authoritah(key, {
            ttl: 1
        });

        return authority.ready()
            .then(() => eventShouldEmit(authority, 'lost', 1500));
    });

    it('lock should not timeout if extended', done => {
        let authority = new Authoritah(key, {
            ttl: 1
        });

        var extender;

        return authority.ready()
            .then(() => {
                extender = setInterval(() => {
                    authority.extend();
                }, 100);
                
                return eventShouldEmit(authority, 'lost', 1500);
            })
            .catch(Promise.TimeoutError, err => {
                clearInterval(extender);
                return authority.release()
                    .finally(() => { done(); });
            });
    });

    it('authority should be received when previous authority is released', () => {
        let authority = new Authoritah(key);
        let nonAuthority = new Authoritah(key);

        return authority.ready()
            .then(() => nonAuthority.ready())
            .then(() => authority.release())
            .then(() => eventShouldEmit(nonAuthority, 'acquired', 1000))
            .tap(() => nonAuthority.release());
    });

    it('authority should be received when previous authority times out', () => {
        let authority = new Authoritah(key, {
            ttl: 1
        });
        let nonAuthority = new Authoritah(key);

        return authority.ready()
            .then(() => nonAuthority.ready())
            .then(() => eventShouldEmit(authority, 'lost'))
            .then(() => eventShouldEmit(nonAuthority, 'acquired', 1000))
            .finally(() => nonAuthority.release());
    });

    it('#extend() should attempt to-relock an expired lock', () => {
        let authority = new Authoritah(key, {
            ttl: 1
        });

        return authority.ready()
            .then(() => eventShouldEmit(authority, 'lost', 1500))
            .then(() => authority.extend())
            .tap(() => authority.release());
    });

    it('if lock is forcefully deleted, it should be re-acquired', () => {
        let authority = new Authoritah(key);

        return authority.ready()
            .then(() =>
                Promise.all([
                    eventShouldEmit(authority, ['lost', 'acquired']),
                    authority.etcd.deleteAsync(authority.key)
                ])
            )
            .tap(() => authority.release());
    });
    
    it('extend should recover if unknowingly lost key', () => {
        let authority = new Authoritah(key);

        return Promise.coroutine(function*() {
            yield authority.ready();

            authority.$watcher.stop();
            authority.$watcher.index = null;
            yield authority.etcd.deleteAsync(authority.key);

            yield authority.extend();

            yield authority.release();
        }).apply(this);
    });

    it('extend should recover if unknowingly lost key', () => {
        let authority = new Authoritah(key);

        return Promise.coroutine(function*() {
            yield authority.ready();

            authority.$watcher.stop();
            yield authority.etcd.deleteAsync(authority.key);

            yield authority.extend();

            yield authority.release();
        }).apply(this);
    });

    it('extend should recover if, unknowingly, key was stolen', () => {
        let authority = new Authoritah(key);

        return Promise.coroutine(function*() {
            yield authority.ready();

            authority.$watcher.stop();
            yield authority.etcd.setAsync(authority.key, '....', {ttl: 1});

            yield authority.extend().catch(_.noop);

            yield authority.extend();

            yield authority.release();
        }).apply(this);
    });
});
