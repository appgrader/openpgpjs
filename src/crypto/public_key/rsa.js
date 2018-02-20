// GPG4Browsers - An OpenPGP implementation in javascript
// Copyright (C) 2011 Recurity Labs GmbH
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 3.0 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA
//
// RSA implementation

/**
 * @requires bn.js
 * @requires asmcrypto.js
 * @requires crypto/public_key/jsbn
 * @requires crypto/random
 * @requires config
 * @requires util
 * @module crypto/public_key/rsa
 */


import BN from 'bn.js';
import { RSA_RAW } from 'asmcrypto.js';
import BigInteger from './jsbn';
import random from '../random';
import config from '../../config';
import util from '../../util';

function SecureRandom() {
  function nextBytes(byteArray) {
    for (let n = 0; n < byteArray.length; n++) {
      byteArray[n] = random.getSecureRandomOctet();
    }
  }
  this.nextBytes = nextBytes;
}

let blinder = BigInteger.ZERO;
let unblinder = BigInteger.ZERO;

function blind(m, n, e) {
  if (unblinder.bitLength() === n.bitLength()) {
    unblinder = unblinder.square().mod(n);
  } else {
    unblinder = random.getRandomBigIntegerInRange(BigInteger.TWO, n);
  }
  blinder = unblinder.modInverse(n).modPow(e, n);
  return m.multiply(blinder).mod(n);
}

function unblind(t, n) {
  return t.multiply(unblinder).mod(n);
}

export default {
  /**
   * This function uses jsbn Big Num library to decrypt RSA
   * @param m message
   * @param n RSA public modulus n as BigInteger
   * @param e RSA public exponent as BigInteger
   * @param d RSA d as BigInteger
   * @param p RSA p as BigInteger
   * @param q RSA q as BigInteger
   * @param u RSA u as BigInteger
   * @return {BigInteger} The decrypted value of the message
   */
  decrypt: function(m, n, e, d, p, q, u) {
    const dd = new BN(d);
    const dp = dd.mod(new BN(p).subn(1)).toArrayLike(Uint8Array); // d mod (p-1)
    const dq = dd.mod(new BN(q).subn(1)).toArrayLike(Uint8Array); // d mod (q-1)
    return new BN(RSA_RAW.decrypt(m, [n, e, d, q, p, dq, dp, u]).slice(1)); // FIXME remove slice
/*
    if (config.rsa_blinding) {
      m = blind(m, n, e);
    }
    const xp = m.mod(p).modPow(d.mod(p.subtract(BigInteger.ONE)), p);
    const xq = m.mod(q).modPow(d.mod(q.subtract(BigInteger.ONE)), q);
    util.print_debug("rsa.js decrypt\nxpn:" + util.hexstrdump(xp.toMPI()) + "\nxqn:" + util.hexstrdump(xq.toMPI()));

    let t = xq.subtract(xp);
    if (t[0] === 0) {
      t = xp.subtract(xq);
      t = t.multiply(u).mod(q);
      t = q.subtract(t);
    } else {
      t = t.multiply(u).mod(q);
    }
    t = t.multiply(p).add(xp);

    if (config.rsa_blinding) {
      t = unblind(t, n);
    }
    return t;
*/
  },

  /**
   * encrypt message
   * @param m message as BigInteger
   * @param n public MPI part as BigInteger
   * @param e public MPI part as BigInteger
   * @return BigInteger
   */
  encrypt: function(m, n, e) {
//    return m.modPowInt(e, n);
    return RSA_RAW.encrypt(m, [n, e]);
  },

  /* Sign and Verify */
  sign: function(m, n, e, d) {
//    return m.modPow(d, n);
    return RSA_RAW.sign(m, [n, e, d]);
  },

  verify: function(x, n, e) {
//    return x.modPowInt(e, n);
    return RSA_RAW.verify(x, [n, e]);
  },

  // Generate a new random private key B bits long, using public expt E

  generate: function(B, E) {
    const webCrypto = util.getWebCryptoAll();

    //
    // Native RSA keygen using Web Crypto
    //

    if (webCrypto) {
      const Euint32 = new Uint32Array([parseInt(E, 16)]); // get integer of exponent
      const Euint8 = new Uint8Array(Euint32.buffer); // get bytes of exponent
      let keyGenOpt;

      let keys;
      if ((window.crypto && window.crypto.subtle) || window.msCrypto) {
        // current standard spec
        keyGenOpt = {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: B, // the specified keysize in bits
          publicExponent: Euint8.subarray(0, 3), // take three bytes (max 65537)
          hash: {
            name: 'SHA-1' // not required for actual RSA keys, but for crypto api 'sign' and 'verify'
          }
        };

        keys = webCrypto.generateKey(keyGenOpt, true, ['sign', 'verify']);
        if (typeof keys.then !== 'function') { // IE11 KeyOperation
          keys = util.promisifyIE11Op(keys, 'Error generating RSA key pair.');
        }
      }
      else if (window.crypto && window.crypto.webkitSubtle) {
        // outdated spec implemented by old Webkit
        keyGenOpt = {
          name: 'RSA-OAEP',
          modulusLength: B, // the specified keysize in bits
          publicExponent: Euint8.subarray(0, 3), // take three bytes (max 65537)
          hash: {
            name: 'SHA-1' // not required for actual RSA keys, but for crypto api 'sign' and 'verify'
          }
        };
        keys = webCrypto.generateKey(keyGenOpt, true, ['encrypt', 'decrypt']);
      }
      else {
        throw new Error('Unknown WebCrypto implementation');
      }

      return keys.then(exportKey).then(function(key) {
        if (key instanceof ArrayBuffer) {
          // parse raw ArrayBuffer bytes to jwk/json (WebKit/Safari/IE11 quirk)
          return decodeKey(JSON.parse(String.fromCharCode.apply(null, new Uint8Array(key))));
        }
        return decodeKey(key);
      });
    }

    // "empty" RSA key constructor

    function KeyObject() {
      this.n = null;
      this.e = 0;
      this.ee = null;
      this.d = null;
      this.p = null;
      this.q = null;
      this.dmp1 = null;
      this.dmq1 = null;
      this.u = null;
    }

    function exportKey(keypair) {
      // export the generated keys as JsonWebKey (JWK)
      // https://tools.ietf.org/html/draft-ietf-jose-json-web-key-33
      let key = webCrypto.exportKey('jwk', keypair.privateKey);
      if (typeof key.then !== 'function') { // IE11 KeyOperation
        key = util.promisifyIE11Op(key, 'Error exporting RSA key pair.');
      }
      return key;
    }

    function decodeKey(jwk) {
      // map JWK parameters to local BigInteger type system
      const key = new KeyObject();
      key.n = toBigInteger(jwk.n);
      key.ee = new BigInteger(E, 16);
      key.d = toBigInteger(jwk.d);
      key.p = toBigInteger(jwk.p);
      key.q = toBigInteger(jwk.q);
      key.u = key.p.modInverse(key.q);

      function toBigInteger(base64url) {
        const base64 = base64url.replace(/\-/g, '+').replace(/_/g, '/');
        const hex = util.hexstrdump(atob(base64));
        return new BigInteger(hex, 16);
      }

      return key;
    }

    //
    // JS code
    //

    return new Promise(function(resolve) {
      const key = new KeyObject();
      const rng = new SecureRandom();
      const qs = B >> 1;
      key.e = parseInt(E, 16);
      key.ee = new BigInteger(E, 16);

      for (;;) {
        for (;;) {
          key.p = new BigInteger(B - qs, 1, rng);
          if (key.p.subtract(BigInteger.ONE).gcd(key.ee).compareTo(BigInteger.ONE) === 0 && key.p.isProbablePrime(10)) {
            break;
          }
        }
        for (;;) {
          key.q = new BigInteger(qs, 1, rng);
          if (key.q.subtract(BigInteger.ONE).gcd(key.ee).compareTo(BigInteger.ONE) === 0 && key.q.isProbablePrime(10)) {
            break;
          }
        }
        if (key.p.compareTo(key.q) <= 0) {
          const t = key.p;
          key.p = key.q;
          key.q = t;
        }
        const p1 = key.p.subtract(BigInteger.ONE);
        const q1 = key.q.subtract(BigInteger.ONE);
        const phi = p1.multiply(q1);
        if (phi.gcd(key.ee).compareTo(BigInteger.ONE) === 0) {
          key.n = key.p.multiply(key.q);
          key.d = key.ee.modInverse(phi);
          key.dmp1 = key.d.mod(p1);
          key.dmq1 = key.d.mod(q1);
          key.u = key.p.modInverse(key.q);
          break;
        }
      }

      resolve(key);
    });
  }
};
