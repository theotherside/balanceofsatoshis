const {homedir} = require('os');
const {platform} = require('os');
const {publicEncrypt} = require('crypto');
const {readFile} = require('fs');
const {spawn} = require('child_process');

const asyncAuto = require('async/auto');
const {restrictMacaroon} = require('ln-service');
const {returnResult} = require('asyncjs-util');

const {decryptCiphertext} = require('./../encryption');
const {derAsPem} = require('./../encryption');
const getCert = require('./get_cert');
const getMacaroon = require('./get_macaroon');
const {getSavedCredentials} = require('./../nodes');
const getSocket = require('./get_socket');

const fs = {getFile: readFile};
const os = {homedir, platform};
const socket = 'localhost:10009';

/** LND credentials

  {
    [expiry]: <Credential Expiration Date ISO 8601 Date String>
    [key]: <Encrypt to Public Key DER Hex String>
    [logger]: <Winston Logger Object>
    [node]: <Node Name String> // Defaults to default local mainnet node creds
  }

  @returns via cbk or Promise
  {
    cert: <Cert String>
    [encrypted_macaroon]: <Encrypted Macaroon Base64 String>
    [external_socket]: <External RPC Socket String>
    macaroon: <Macaroon String>
    socket: <Socket String>
  }
*/
module.exports = ({expiry, logger, key, node}, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Get the default cert
      getCert: cbk => getCert({fs, node, os}, cbk),

      // Get the default macaroon
      getMacaroon: cbk => getMacaroon({fs, node, os}, cbk),

      // Get the node credentials, if applicable
      getNodeCredentials: cbk => {
        if (!node) {
          return cbk();
        }

        return getSavedCredentials({fs, node}, cbk);
      },

      // Get the socket out of the ini file
      getSocket: cbk => getSocket({fs, node, os}, cbk),

      // Node credentials
      nodeCredentials: ['getNodeCredentials', ({getNodeCredentials}, cbk) => {
        if (!node) {
          return cbk();
        }

        if (!getNodeCredentials.credentials) {
          return cbk([400, 'CredentialsForSpecifiedNodeNotFound']);
        }

        const {credentials} = getNodeCredentials;

        if (!credentials.encrypted_macaroon) {
          return cbk(null, {
            cert: credentials.cert,
            macaroon: credentials.macaroon,
            socket: credentials.socket,
          });
        }

        const cipher = credentials.encrypted_macaroon;

        if (!!logger) {
          logger.info({decrypt_credentials_for: node});
        }

        return decryptCiphertext({cipher, spawn}, (err, res) => {
          if (!!err) {
            return cbk(err);
          }

          return cbk(null, {
            cert: credentials.cert,
            macaroon: res.clear,
            socket: credentials.socket,
          });
        });
      }],

      // Credentials to use
      credentials: [
        'getCert',
        'getMacaroon',
        'nodeCredentials',
        ({getCert, getMacaroon, nodeCredentials}, cbk) =>
      {
        // Exit early with the default credentials when no node is specified
        if (!node) {
          return cbk(null, {
            socket,
            cert: getCert.cert,
            macaroon: getMacaroon.macaroon,
          });
        }

        return cbk(null, {
          cert: nodeCredentials.cert,
          macaroon: nodeCredentials.macaroon,
          socket: nodeCredentials.socket,
        });
      }],

      // Macaroon with restriction
      macaroon: ['credentials', ({credentials}, cbk) => {
        if (!expiry) {
          return cbk(null, credentials.macaroon);
        }

        const {macaroon} = restrictMacaroon({
          expires_at: expiry,
          macaroon: credentials.macaroon,
        });

        return cbk(null, macaroon);
      }],

      // Final credentials with encryption applied
      finalCredentials: [
        'credentials',
        'getSocket',
        'macaroon',
        ({credentials, getSocket, macaroon}, cbk) =>
      {
        // Exit early when the credentials are not encrypted
        if (!key) {
          return cbk(null, {
            macaroon,
            cert: credentials.cert,
            socket: credentials.socket,
          });
        }

        const macaroonData = Buffer.from(macaroon, 'base64');

        const encrypted = publicEncrypt(derAsPem({key}).pem, macaroonData);

        return cbk(null, {
          cert: credentials.cert,
          encrypted_macaroon: encrypted.toString('base64'),
          external_socket: getSocket.socket,
          socket: credentials.socket,
        });
      }],
    },
    returnResult({reject, resolve, of: 'finalCredentials'}, cbk));
  });
};
