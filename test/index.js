const fs = require('fs');
const url = require('url');
const path = require('path');

const {expect, assert} = require('chai');
const nock = require('nock');

const NVD = require('../index');

describe('NVD Class', () => {
  before(done => {
    try {
      fs.unlinkSync(path.join(__dirname, 'data', 'cache',
        'nvdcve-1.0-modified.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    done();
  });

  describe('nvd.parseMetaFile()', () => {
    it('Correctly parses a feed meta file to an object', done => {
      const metaFileObj = require('./data/nvdcve-1.0-recent.meta.json');
      const testFilePath = path.join(__dirname, 'data', 'nvdcve-1.0-recent.meta');
      const metaFileContents = fs.readFileSync(testFilePath).toString('utf8');
      const parsedMetaFile = NVD.parseMetaFile(metaFileContents);
      expect(parsedMetaFile).to.deep.equal(metaFileObj);
      done();
    });
  });

  describe('nvd.sync()', () => {
    it('Fetches all desired files', done => {
      const nvd = new NVD({
        feeds: ['recent', 'modified'],
        cacheDir: path.join(__dirname, 'data', 'cache')
      });

      const syncURL = url.parse(nvd.config.rootPath);
      const syncScope = nock(`${syncURL.protocol}//${syncURL.hostname}`)
        .get(`${syncURL.pathname}-recent.meta`)
        .reply(200, fs.readFileSync(path.join(__dirname, 'data',
          'nvdcve-1.0-recent.meta')).toString('utf8'));

      syncScope.get(`${syncURL.pathname}-modified.meta`)
        .reply(200, fs.readFileSync(path.join(__dirname, 'data',
          'nvdcve-1.0-modified.meta')).toString('utf8'));

      syncScope.get(`${syncURL.pathname}-modified.json.gz`)
        .reply(200, (uri, requestBody) => {
          return fs.createReadStream(path.join(__dirname, 'data',
            'nvdcve-1.0-modified.json.gz'));
        });

      nvd.sync((error, results) => {
        if (error) {
          return console.error(error);
        }
        expect(results).to.deep.equal([{
          feed: 'recent',
          fetchRemote: false,
          metadata: {
            lastModifiedDate: '2019-07-19T20:00:55-04:00',
            size: '4336300',
            zipSize: '243985',
            gzSize: '243845',
            sha256: 'DA0B3030EF781806228ED40A7F295182AC835E96F4F5B27C258228531FBBED0C'
          },
          progress: undefined
        },
        {
          feed: 'modified',
          metadata: {
            lastModifiedDate: '2019-07-22T14:02:09-04:00',
            size: '6575683',
            zipSize: '354809',
            gzSize: '354665',
            sha256: '0BF42E5E2CF81A7F3F9A6F1581BF54D5E970185D96D3D9011ED63AA695FB7B2D'
          },
          fetchRemote: true,
          progress: undefined
        }]);
        syncScope.done();
        done();
      });
    });
  });
});