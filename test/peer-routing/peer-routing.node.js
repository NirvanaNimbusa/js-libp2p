'use strict'
/* eslint-env mocha */

const { expect } = require('aegir/utils/chai')
const nock = require('nock')
const sinon = require('sinon')
const intoStream = require('into-stream')

const delay = require('delay')
const pDefer = require('p-defer')
const pWaitFor = require('p-wait-for')
const mergeOptions = require('merge-options')

const ipfsHttpClient = require('ipfs-http-client')
const DelegatedPeerRouter = require('libp2p-delegated-peer-routing')
const multiaddr = require('multiaddr')
const PeerId = require('peer-id')

const peerUtils = require('../utils/creators/peer')
const { baseOptions, routingOptions } = require('./utils')

describe('peer-routing', () => {
  describe('no routers', () => {
    let node

    before(async () => {
      [node] = await peerUtils.createPeer({
        config: baseOptions
      })
    })

    it('.findPeer should return an error', async () => {
      await expect(node.peerRouting.findPeer('a cid'))
        .to.eventually.be.rejected()
        .and.to.have.property('code', 'NO_ROUTERS_AVAILABLE')
    })

    it('.getClosestPeers should return an error', async () => {
      try {
        for await (const _ of node.peerRouting.getClosestPeers('a cid')) { } // eslint-disable-line
        throw new Error('.getClosestPeers should return an error')
      } catch (err) {
        expect(err).to.exist()
        expect(err.code).to.equal('NO_ROUTERS_AVAILABLE')
      }
    })
  })

  describe('via dht router', () => {
    const number = 5
    let nodes

    before(async () => {
      nodes = await peerUtils.createPeer({
        number,
        config: routingOptions
      })

      // Ring dial
      await Promise.all(
        nodes.map((peer, i) => peer.dial(nodes[(i + 1) % number].peerId))
      )
    })

    after(() => {
      sinon.restore()
    })

    after(() => Promise.all(nodes.map((n) => n.stop())))

    it('should use the nodes dht', () => {
      const deferred = pDefer()

      sinon.stub(nodes[0]._dht, 'findPeer').callsFake(() => {
        deferred.resolve()
        return nodes[1].peerId
      })

      nodes[0].peerRouting.findPeer()
      return deferred.promise
    })

    it('should use the nodes dht to get the closest peers', async () => {
      const deferred = pDefer()

      sinon.stub(nodes[0]._dht, 'getClosestPeers').callsFake(function * () {
        deferred.resolve()
        yield
      })

      await nodes[0].peerRouting.getClosestPeers().next()

      return deferred.promise
    })
  })

  describe('via delegate router', () => {
    let node
    let delegate

    beforeEach(async () => {
      delegate = new DelegatedPeerRouter(ipfsHttpClient({
        host: '0.0.0.0',
        protocol: 'http',
        port: 60197
      }))

      ;[node] = await peerUtils.createPeer({
        config: mergeOptions(baseOptions, {
          modules: {
            peerRouting: [delegate]
          },
          config: {
            dht: {
              enabled: false
            }
          }
        })
      })
    })

    afterEach(() => {
      nock.cleanAll()
      sinon.restore()
    })

    afterEach(() => node.stop())

    it('should use the delegate router to find peers', async () => {
      const deferred = pDefer()

      sinon.stub(delegate, 'findPeer').callsFake(() => {
        deferred.resolve()
        return 'fake peer-id'
      })

      await node.peerRouting.findPeer()
      return deferred.promise
    })

    it('should use the delegate router to get the closest peers', async () => {
      const deferred = pDefer()

      sinon.stub(delegate, 'getClosestPeers').callsFake(function * () {
        deferred.resolve()
        yield
      })

      await node.peerRouting.getClosestPeers().next()

      return deferred.promise
    })

    it('should be able to find a peer', async () => {
      const peerKey = 'QmTp9VkYvnHyrqKQuFPiuZkiX9gPcqj6x5LJ1rmWuSySnL'
      const mockApi = nock('http://0.0.0.0:60197')
        .post('/api/v0/dht/findpeer')
        .query(true)
        .reply(200, `{"Extra":"","ID":"some other id","Responses":null,"Type":0}\n{"Extra":"","ID":"","Responses":[{"Addrs":["/ip4/127.0.0.1/tcp/4001"],"ID":"${peerKey}"}],"Type":2}\n`, [
          'Content-Type', 'application/json',
          'X-Chunked-Output', '1'
        ])

      const peer = await node.peerRouting.findPeer(peerKey)

      expect(peer.id).to.equal(peerKey)
      expect(mockApi.isDone()).to.equal(true)
    })

    it('should error when a peer cannot be found', async () => {
      const peerKey = 'key of a peer not on the network'
      const mockApi = nock('http://0.0.0.0:60197')
        .post('/api/v0/dht/findpeer')
        .query(true)
        .reply(200, '{"Extra":"","ID":"some other id","Responses":null,"Type":6}\n{"Extra":"","ID":"yet another id","Responses":null,"Type":0}\n{"Extra":"routing:not found","ID":"","Responses":null,"Type":3}\n', [
          'Content-Type', 'application/json',
          'X-Chunked-Output', '1'
        ])

      await expect(node.peerRouting.findPeer(peerKey))
        .to.eventually.be.rejected()

      expect(mockApi.isDone()).to.equal(true)
    })

    it('should handle errors from the api', async () => {
      const peerKey = 'key of a peer not on the network'
      const mockApi = nock('http://0.0.0.0:60197')
        .post('/api/v0/dht/findpeer')
        .query(true)
        .reply(502)

      await expect(node.peerRouting.findPeer(peerKey))
        .to.eventually.be.rejected()

      expect(mockApi.isDone()).to.equal(true)
    })

    it('should be able to get the closest peers', async () => {
      const peerId = await PeerId.create({ keyType: 'ed25519' })

      const closest1 = '12D3KooWLewYMMdGWAtuX852n4rgCWkK7EBn4CWbwwBzhsVoKxk3'
      const closest2 = '12D3KooWDtoQbpKhtnWddfj72QmpFvvLDTsBLTFkjvgQm6cde2AK'

      const mockApi = nock('http://0.0.0.0:60197')
        .post('/api/v0/dht/query')
        .query(true)
        .reply(200,
          () => intoStream([
            `{"extra":"","id":"${closest1}","responses":[{"ID":"${closest1}","Addrs":["/ip4/127.0.0.1/tcp/63930","/ip4/127.0.0.1/tcp/63930"]}],"type":1}\n`,
            `{"extra":"","id":"${closest2}","responses":[{"ID":"${closest2}","Addrs":["/ip4/127.0.0.1/tcp/63506","/ip4/127.0.0.1/tcp/63506"]}],"type":1}\n`,
            `{"Extra":"","ID":"${closest2}","Responses":[],"Type":2}\n`,
            `{"Extra":"","ID":"${closest1}","Responses":[],"Type":2}\n`
          ]),
          [
            'Content-Type', 'application/json',
            'X-Chunked-Output', '1'
          ])

      const closestPeers = []
      for await (const peer of node.peerRouting.getClosestPeers(peerId.id, { timeout: 1000 })) {
        closestPeers.push(peer)
      }

      expect(closestPeers).to.have.length(2)
      expect(closestPeers[0].id.toB58String()).to.equal(closest2)
      expect(closestPeers[0].multiaddrs).to.have.lengthOf(2)
      expect(closestPeers[1].id.toB58String()).to.equal(closest1)
      expect(closestPeers[1].multiaddrs).to.have.lengthOf(2)
      expect(mockApi.isDone()).to.equal(true)
    })

    it('should handle errors when getting the closest peers', async () => {
      const peerId = await PeerId.create({ keyType: 'ed25519' })

      const mockApi = nock('http://0.0.0.0:60197')
        .post('/api/v0/dht/query')
        .query(true)
        .reply(502, 'Bad Gateway', [
          'X-Chunked-Output', '1'
        ])

      try {
        for await (const _ of node.peerRouting.getClosestPeers(peerId.id)) { } // eslint-disable-line
        throw new Error('should handle errors when getting the closest peers')
      } catch (err) {
        expect(err).to.exist()
      }

      expect(mockApi.isDone()).to.equal(true)
    })
  })

  describe('via dht and delegate routers', () => {
    let node
    let delegate

    beforeEach(async () => {
      delegate = new DelegatedPeerRouter(ipfsHttpClient({
        host: '0.0.0.0',
        protocol: 'http',
        port: 60197
      }))

      ;[node] = await peerUtils.createPeer({
        config: mergeOptions(routingOptions, {
          modules: {
            peerRouting: [delegate]
          }
        })
      })
    })

    afterEach(() => {
      sinon.restore()
    })

    afterEach(() => node.stop())

    it('should only use the dht if it finds the peer', async () => {
      const dhtDeferred = pDefer()

      sinon.stub(node._dht, 'findPeer').callsFake(() => {
        dhtDeferred.resolve()
        return { id: node.peerId }
      })
      sinon.stub(delegate, 'findPeer').callsFake(() => {
        throw new Error('the delegate should not have been called')
      })

      await node.peerRouting.findPeer('a peer id')
      await dhtDeferred.promise
    })

    it('should use the delegate if the dht fails to find the peer', async () => {
      const results = [true]

      sinon.stub(node._dht, 'findPeer').callsFake(() => {})
      sinon.stub(delegate, 'findPeer').callsFake(() => {
        return results
      })

      const peer = await node.peerRouting.findPeer('a peer id')
      expect(peer).to.eql(results)
    })

    it('should only use the dht if it gets the closest peers', async () => {
      const results = [true]

      sinon.stub(node._dht, 'getClosestPeers').callsFake(function * () {
        yield results[0]
      })

      sinon.stub(delegate, 'getClosestPeers').callsFake(function * () { // eslint-disable-line require-yield
        throw new Error('the delegate should not have been called')
      })

      const closest = []
      for await (const peer of node.peerRouting.getClosestPeers('a cid')) {
        closest.push(peer)
      }

      expect(closest).to.have.length.above(0)
      expect(closest).to.eql(results)
    })

    it('should use the delegate if the dht fails to get the closest peer', async () => {
      const results = [true]

      sinon.stub(node._dht, 'getClosestPeers').callsFake(function * () { })

      sinon.stub(delegate, 'getClosestPeers').callsFake(function * () {
        yield results[0]
      })

      const closest = []
      for await (const peer of node.peerRouting.getClosestPeers('a cid')) {
        closest.push(peer)
      }

      expect(closest).to.have.length.above(0)
      expect(closest).to.eql(results)
    })
  })

  describe('peer routing refresh manager service', () => {
    let node
    let peerIds

    before(async () => {
      peerIds = await peerUtils.createPeerId({ number: 2 })
    })

    afterEach(() => {
      sinon.restore()

      return node && node.stop()
    })

    it('should be enabled and start by default', async () => {
      const results = [
        { id: peerIds[0], multiaddrs: [multiaddr('/ip4/30.0.0.1/tcp/2000')] },
        { id: peerIds[1], multiaddrs: [multiaddr('/ip4/32.0.0.1/tcp/2000')] }
      ]

      ;[node] = await peerUtils.createPeer({
        config: mergeOptions(routingOptions, {
          peerRouting: {
            refreshManager: {
              bootDelay: 100
            }
          }
        }),
        started: false
      })

      sinon.spy(node.peerStore.addressBook, 'add')
      sinon.stub(node._dht, 'getClosestPeers').callsFake(function * () {
        yield results[0]
        yield results[1]
      })

      await node.start()

      await pWaitFor(() => node._dht.getClosestPeers.callCount === 1)
      await pWaitFor(() => node.peerStore.addressBook.add.callCount === results.length)

      const call0 = node.peerStore.addressBook.add.getCall(0)
      expect(call0.args[0].equals(results[0].id))
      call0.args[1].forEach((m, index) => {
        expect(m.equals(results[0].multiaddrs[index]))
      })

      const call1 = node.peerStore.addressBook.add.getCall(1)
      expect(call1.args[0].equals(results[1].id))
      call0.args[1].forEach((m, index) => {
        expect(m.equals(results[1].multiaddrs[index]))
      })
    })

    it('should support being disabled', async () => {
      [node] = await peerUtils.createPeer({
        config: mergeOptions(routingOptions, {
          peerRouting: {
            refreshManager: {
              bootDelay: 100,
              enabled: false
            }
          }
        }),
        started: false
      })

      sinon.stub(node._dht, 'getClosestPeers').callsFake(function * () {
        yield
        throw new Error('should not be called')
      })

      await node.start()
      await delay(100)

      expect(node._dht.getClosestPeers.callCount === 0)
    })

    it('should start and run recurrently on interval', async () => {
      [node] = await peerUtils.createPeer({
        config: mergeOptions(routingOptions, {
          peerRouting: {
            refreshManager: {
              interval: 500,
              bootDelay: 200
            }
          }
        }),
        started: false
      })

      sinon.stub(node._dht, 'getClosestPeers').callsFake(function * () {
        yield { id: peerIds[0], multiaddrs: [multiaddr('/ip4/30.0.0.1/tcp/2000')] }
      })

      await node.start()

      await delay(300)
      expect(node._dht.getClosestPeers.callCount).to.eql(1)
      await delay(500)
      expect(node._dht.getClosestPeers.callCount).to.eql(2)
    })
  })
})
