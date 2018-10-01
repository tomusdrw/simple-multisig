var SimpleMultiSig = artifacts.require("./SimpleMultiSig.sol")
var TestRegistry = artifacts.require("./TestRegistry.sol")
var lightwallet = require('eth-lightwallet')
const solsha3 = require('solidity-sha3').default
const leftPad = require('left-pad')
const Promise = require('bluebird')
const BigNumber = require('bignumber.js')

const web3SendTransaction = Promise.promisify(web3.eth.sendTransaction)
const web3GetBalance = Promise.promisify(web3.eth.getBalance)

contract('SimpleMultiSig', function(accounts) {

  let keyFromPw
  let acct
  let lw

  let createSigs = function(signers, multisigAddr, nonce, destinationAddr, value, data) {

    let input = '0x19' + '00' + multisigAddr.slice(2) + destinationAddr.slice(2) + leftPad(value.toString('16'), '64', '0') + data.slice(2) + leftPad(nonce.toString('16'), '64', '0')
    let hash = solsha3(input)

    let sigV = []
    let sigR = []
    let sigS = []

    for (var i=0; i<signers.length; i++) {
      let sig = lightwallet.signing.signMsgHash(lw, keyFromPw, hash, signers[i])
      sigV.push(sig.v)
      sigR.push('0x' + sig.r.toString('hex'))
      sigS.push('0x' + sig.s.toString('hex'))
    }

    return {sigV: sigV, sigR: sigR, sigS: sigS}

  }

  let multisig = async function(owners, threshold) {
    const contract = await SimpleMultiSig.new(threshold, owners, {from: accounts[0]})
    contract.owners = owners;
    return contract
  }

  let executeSendSuccess = async function(multisigPromise, signers, done, expectedNonce = 0) {

    let multisig = await multisigPromise

    let randomAddr = solsha3(Math.random()).slice(0,42)

    // Receive funds
    await web3SendTransaction({from: accounts[0], to: multisig.address, value: web3.toWei(new BigNumber(0.1), 'ether')})

    let nonce = await multisig.nonce.call()
    assert.equal(nonce.toNumber(), expectedNonce)

    let bal = await web3GetBalance(multisig.address)
    assert.equal(bal, web3.toWei(0.1, 'ether'))

    // check that owners are stored correctly
    for (var i=0; i<multisig.owners.length; i++) {
      let ownerFromContract = await multisig.ownersArr.call(i)
      assert.equal(multisig.owners[i], ownerFromContract)
    }

    let value = web3.toWei(new BigNumber(0.01), 'ether')

    let sigs = createSigs(signers, multisig.address, nonce, randomAddr, value, '0x')

    await multisig.execute(sigs.sigV, sigs.sigR, sigs.sigS, randomAddr, value, '0x', {from: accounts[0], gasLimit: 1000000})

    // Check funds sent
    bal = await web3GetBalance(randomAddr)
    assert.equal(bal.toString(), value.toString())

    // Check nonce updated
    nonce = await multisig.nonce.call()
    assert.equal(nonce.toNumber(), expectedNonce + 1)

    // Send again
    sigs = createSigs(signers, multisig.address, nonce, randomAddr, value, '0x')
    await multisig.execute(sigs.sigV, sigs.sigR, sigs.sigS, randomAddr, value, '0x', {from: accounts[0], gasLimit: 1000000})

    // Check funds
    bal = await web3GetBalance(randomAddr)
    assert.equal(bal.toString(), (value*2).toString())

    // Check nonce updated
    nonce = await multisig.nonce.call()
    assert.equal(nonce.toNumber(), expectedNonce + 2)

    // Test contract interactions
    let reg = await TestRegistry.new({from: accounts[0]})

    let number = 12345
    let data = lightwallet.txutils._encodeFunctionTxData('register', ['uint256'], [number])

    sigs = createSigs(signers, multisig.address, nonce, reg.address, value, data)
    await multisig.execute(sigs.sigV, sigs.sigR, sigs.sigS, reg.address, value, data, {from: accounts[0], gasLimit: 1000000})

    // Check that number has been set in registry
    let numFromRegistry = await reg.registry(multisig.address)
    assert.equal(numFromRegistry.toNumber(), number)

    // Check funds in registry
    bal = await web3GetBalance(reg.address)
    assert.equal(bal.toString(), value.toString())

    // Check nonce updated
    nonce = await multisig.nonce.call()
    assert.equal(nonce.toNumber(), expectedNonce + 3)

    done()
  }

  let executeSendFailure = async function(multisigPromise, signers, done, expectedNonce = 0) {

    let multisig = await multisigPromise

    let nonce = await multisig.nonce.call()
    assert.equal(nonce.toNumber(), expectedNonce)

    // Receive funds
    await web3SendTransaction({from: accounts[0], to: multisig.address, value: web3.toWei(new BigNumber(2), 'ether')})

    let randomAddr = solsha3(Math.random()).slice(0,42)
    let value = web3.toWei(new BigNumber(0.1), 'ether')
    let sigs = createSigs(signers, multisig.address, nonce, randomAddr, value, '0x')

    try {
      await multisig.execute(sigs.sigV, sigs.sigR, sigs.sigS, randomAddr, value, '0x', {from: accounts[0], gasLimit: 1000000})
    } catch(error) {
      assertReverted(error)
    }


    done()
  }

  let creationFailure = async function(owners, threshold, done) {

    try {
      await multisig(owners, threshold)
    } catch(error) {
      assertReverted(error)
    }

    done()
  }

  let assertReverted = (error) => {
      assert.equal(error.message, 'VM Exception while processing transaction: revert', 'Test did not throw')
  }
  
  before((done) => {

    let seed = "pull rent tower word science patrol economy legal yellow kit frequent fat"

    lightwallet.keystore.createVault(
    {hdPathString: "m/44'/60'/0'/0",
     seedPhrase: seed,
     password: "test",
     salt: "testsalt"
    },
    function (err, keystore) {

      lw = keystore
      lw.keyFromPassword("test", function(e,k) {
        keyFromPw = k

        lw.generateNewAddress(keyFromPw, 20)
        let acctWithout0x = lw.getAddresses()
        acct = acctWithout0x.map((a) => {return a})
        acct.sort()
        done()
      })
    })
  })

  describe("3 signers, threshold 2", () => {

    it("should succeed with signers 0, 1", (done) => {
      let signers = [acct[0], acct[1]]
      signers.sort()
      executeSendSuccess(multisig(acct.slice(0,3), 2), signers, done)
    })

    it("should succeed with signers 0, 2", (done) => {
      let signers = [acct[0], acct[2]]
      signers.sort()
      executeSendSuccess(multisig(acct.slice(0,3), 2), signers, done)
    })

    it("should succeed with signers 1, 2", (done) => {
      let signers = [acct[1], acct[2]]
      signers.sort()
      executeSendSuccess(multisig(acct.slice(0,3), 2), signers, done)
    })

    it("should fail due to non-owner signer", (done) => {
      let signers = [acct[0], acct[3]]
      signers.sort()
      executeSendFailure(multisig(acct.slice(0,3), 2), signers, done)
    })

    it("should fail with more signers than threshold", (done) => {
      executeSendFailure(multisig(acct.slice(0,3), 2), acct.slice(0,3), done)
    })

    it("should fail with fewer signers than threshold", (done) => {
      executeSendFailure(multisig(acct.slice(0,3), 2), [acct[0]], done)
    })

    it("should fail with one signer signing twice", (done) => {
      executeSendFailure(multisig(acct.slice(0,3), 2), [acct[0], acct[0]], done)
    })

    it("should fail with signers in wrong order", (done) => {
      let signers = [acct[0], acct[1]]
      signers.sort().reverse() //opposite order it should be
      executeSendFailure(multisig(acct.slice(0,3), 2), signers, done)
    })

  })  

  describe("Edge cases", () => {
    it("should succeed with 10 owners, 10 signers", (done) => {
      executeSendSuccess(multisig(acct.slice(0,10), 10), acct.slice(0,10), done)
    })

    it("should fail to create with signers 0, 0, 2, and threshold 3", (done) => { 
      creationFailure([acct[0],acct[0],acct[2]], 3, done)
    })

    it("should fail with 0 signers", (done) => {
      executeSendFailure(multisig(acct.slice(0,3), 2), [], done)
    })

    it("should fail with 11 owners", (done) => {
      creationFailure(acct.slice(0,11), 2, done)
    })
  })

  describe("Set owners", () => {
    it("should not allow calling method from any account", async () => {
      const contract = await multisig(acct.slice(0, 3), 2)
      try {
        await contract.setOwners(1, acct.slice(0, 1), {
          from: accounts[0],
          gasLimit: 1000000
        })
      } catch (error) {
        assertReverted(error)
      }
    })

    it("should change owners and fail to send with previous owners", async () => {
      const contract = await multisig(acct.slice(0, 3), 2)
      let data = lightwallet.txutils._encodeFunctionTxData(
        'setOwners',
        ['uint256', 'address[]'],
        [1, acct.slice(6, 9)]
      )
      let sigs = createSigs(
        acct.slice(1, 3),
        contract.address,
        0,
        contract.address,
        0,
        data
      )
      await contract.execute(sigs.sigV, sigs.sigR, sigs.sigS, contract.address, 0, data, {
        from: accounts[9],
        gasLimit: 1000000
      })

      return new Promise((resolve) => {
        executeSendFailure(Promise.resolve(contract), acct.slice(0, 3), resolve, 1)
      })
    })

    it("should change owners and succesfuly send transaction", async () => {
      const contract = await multisig(acct.slice(0, 3), 2)
      let data = lightwallet.txutils._encodeFunctionTxData(
        'setOwners',
        ['uint256', 'address[]'],
        [1, acct.slice(6, 9)]
      )
      let sigs = createSigs(
        acct.slice(1, 3),
        contract.address,
        0,
        contract.address,
        0,
        data
      )
      await contract.execute(sigs.sigV, sigs.sigR, sigs.sigS, contract.address, 0, data, {
        from: accounts[9],
        gasLimit: 1000000
      })

      return new Promise((resolve) => {
        // update contract owners
        contract.owners = acct.slice(6, 9)
        executeSendSuccess(Promise.resolve(contract), acct.slice(6, 7), resolve, 1)
      })
    })
  })
})
