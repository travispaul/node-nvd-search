const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const JSONStream = require('JSONStream');
const request = require('request');
const {forEachParallel, waterfall} = require('vasync');

let PROGRESSFN;

module.exports = class NVD {

  constructor(options = {}) {
    // Defaults and user supplied options combined
    this.defaults = {
      // Which feeds to download and keep up-to-date
      feeds: [
        'modified',
        'recent',
        '2019',
        '2018',
        '2017',
        '2016',
        '2015',
        '2014',
        '2013',
        '2012',
        '2011',
        '2010',
        '2009',
        '2008',
        '2007',
        '2006',
        '2005',
        '2004',
        '2003',
        '2002',
      ],

      // XXX not yet implemented XXX
      // Attempt to fetch all feeds between the last one listed in the `feeds` config
      // and the current year. E.g. if the last year list in `feeds` is 2019, but the
      // current year is 2022, also attempt to fetch and sync feeds for 2020, 2021
      // and 2022 if they exist.
      //includeCurrentYearlyFeeds: false,

      // fetch `${rootPath}-${feed}.json.gz`, if you have a private cache
      // you can override this to fetch from your private cache.
      rootPath: 'https://nvd.nist.gov/feeds/json/cve/1.0/nvdcve-1.0',
      
      // Default location where the json files are stored
      cacheDir: NVD.chooseDefaultCacheDir(),

      // Create a local SQLite database for faster searching
      searchCache: true
    };
    this.config = Object.assign({}, this.defaults, options);
  }

  static parseMetaFile(metaFile) {
    const lines = metaFile.split('\r\n');
    const result = {};
    for (const line of lines) {
      if (!line) continue;
      const key = line.replace(/:.*$/, '');
      const value = line.replace(/^.*?:/, '');
      result[key] = value;
    }
    return result;
  }

  // If user didn't supply a cacheDir, try to pick something sensible based on:
  // https://standards.freedesktop.org/basedir-spec/basedir-spec-latest.html
  //
  // $XDG_CACHE_HOME defines the base directory relative to which user specific
  // non-essential data files should be stored.
  //
  // If $XDG_CACHE_HOME is either not set or empty, a default equal to
  // $HOME/.cache should be used.
  static chooseDefaultCacheDir () {
    if (process.env.XDG_CACHE_HOME) {
      return path.join(process.env.XDG_CACHE_HOME, 'nvd')
    }
    return path.join(os.homedir(), '.cache', 'nvd');
  }

  // Download metafile and convert to an object
  static fetchMetaFile (ctx, done) {
    const metaPath = `${ctx.config.rootPath}-${ctx.feed}.meta`;
    request(metaPath, (error, response, body) => {
      if (error) return done(error);
      ctx.metadata = NVD.parseMetaFile(body);
      done(null, ctx);
    });
  }

  // Determine if local file matches the remoet metadata, if it doesn't set
  // ctx.fetchRemote to true so the next function in the pipeline downloads
  // the latest file.
  static checkLocalFeedFile (ctx, done) {
    const localFeedFile = `${ctx.config.cacheDir}/nvdcve-1.0-${ctx.feed}.json`;
    const reader = fs.createReadStream(localFeedFile);
    const hash = crypto.createHash('sha256');
    hash.setEncoding('hex');

    reader.on('end', () => {
      hash.end();
      const hashValue = hash.read().toUpperCase();
      ctx.fetchRemote = (hashValue !== ctx.metadata.sha256);
      done(null, ctx);
    });

    reader.on('error', (error) => {
      reader.close();
      if (error && error.code !== 'ENOENT') {
        return done(error);
      }
      ctx.fetchRemote = true;
      done(null, ctx);
    });

    reader.pipe(hash);
  }

  // Download and cache the specific remote feed file, unzip it and write it to
  // disk. Only do this if ctx.fetchRemote is true (see checkLocalFeedFile)
  static fetchRemoteFeedFile(ctx, done) {
    if (!ctx.fetchRemote) {
      return done(null, ctx);
    }
    const gzip = zlib.createGunzip();
    const writer = fs.createWriteStream(`${ctx.config.cacheDir}/nvdcve-1.0-${ctx.feed}.json`);
    const httpStream = request(`${ctx.config.rootPath}-${ctx.feed}.json.gz`);

    httpStream.on('error', done);
    gzip.on('error', done);

    writer.on('close', () => {
      done(null, ctx);
    })

    httpStream.pipe(gzip).pipe(writer);
  }

  // download feed metafile and download if remote differs from the loca file
  static fetchFeedWaterfall (ctx, done) {
    waterfall([
        (next) => {
          next(null, ctx);
        },
        NVD.fetchMetaFile,
        NVD.checkLocalFeedFile,
        NVD.fetchRemoteFeedFile
    ], (error, ctx) => {
        if (typeof ctx.progress === 'function') {
          ctx.progress();
        }
        if (error) {
          return done(error);
        }
        done(null, ctx);
    });
  }

  // fetch all the remote feeds (if needed)
  static fetchFeedParallel (contexts, done) {
    forEachParallel({
        func: NVD.fetchFeedWaterfall,
        inputs: contexts
    }, (error, results) => {
        if (error) {
            return done(error);
        }
        const simpleResults = results.operations.map((operation) => {
          delete operation.result.config;
          return operation.result;
        }).filter(val => val);

        done(null, simpleResults);
    });
  }

  // Create the configured cache directory
  static createCacheDir (ctx, next) {
    fs.mkdir(ctx[0].config.cacheDir, {recursive: true}, (error) => {
      if (error) {
        return next(error, ctx);
      }
      next(null, ctx);
    });
  }

  getConfig () {
    return this.config;
  }

  // sync remote files locally
  sync (done, progress) {

    // Provide a copy of the config to each feed
    const contexts = this.config.feeds.map((feed) => {
      return {
        feed,
        progress,
        config: this.config,
      };
    });

    waterfall([
        (next) => {
          next(null, contexts);
        },
        NVD.createCacheDir,
        NVD.fetchFeedParallel,
      ], (error, results) => {
        if (error) {
          return done(error, results);
        }
        done(null, results);
    });
  }

  // making a lot of assumptions here
  search (id) {
    let found = false;
    let count = 0;
    const [_,year] = id.split('-');
    if (this.config.feeds.indexOf(year) !== -1) {
      const reader = fs.createReadStream(`${this.config.cacheDir}/nvdcve-1.0-${year}.json`);
      //const stream = JSONStream.parse('CVE_Items.*.cve.CVE_data_meta.ID')
      const stream = JSONStream.parse('CVE_Items.*.cve')
      reader.pipe(stream);
      console.log(`Searching ${year} feed...`);
      stream.on('data', (data) => {
        count += 1;
        if (data.CVE_data_meta.ID === id) {
          found = true;
          console.log(JSON.stringify(data, null, 2));
          stream.end();
        }
      });

      stream.on('end', () => {
        if (!found) {
          console.log('Not found in %s entries for %s', count, year);
        }
      });
    }
  }
}