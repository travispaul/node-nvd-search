const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const JSONStream = require('JSONStream');
const request = require('request');
const {
  forEachParallel,
  waterfall,
  whilst
} = require('vasync');

// For Node.js versions < 10 that don't support recursive mkdir
// https://stackoverflow.com/questions/31645738/how-to-create-full-path-with-nodes-fs-mkdirsync
function mkDirByPathSync (targetDir, { isRelativeToScript = false } = {}) {
  const sep = path.sep;
  const initDir = path.isAbsolute(targetDir) ? sep : '';
  const baseDir = isRelativeToScript ? __dirname : '.';

  return targetDir.split(sep).reduce((parentDir, childDir) => {
    const curDir = path.resolve(baseDir, parentDir, childDir);
    try {
      fs.mkdirSync(curDir);
    } catch (err) {
      if (err.code === 'EEXIST') { // curDir already exists!
        return curDir;
      }

      // To avoid `EISDIR` error on Mac and `EACCES`-->`ENOENT` and `EPERM` on Windows.
      if (err.code === 'ENOENT') { // Throw the original parentDir error on curDir `ENOENT` failure.
        throw new Error(`EACCES: permission denied, mkdir '${parentDir}'`);
      }

      const caughtErr = ['EACCES', 'EPERM', 'EISDIR'].indexOf(err.code) > -1;
      if (!caughtErr || caughtErr && curDir === path.resolve(targetDir)) {
        throw err; // Throw if it's just the last created dir.
      }
    }

    return curDir;
  }, initDir);
}


module.exports = class NVD {

  constructor (options = {}) {
    // Defaults and user supplied options combined
    this.defaults = {
      // Which feeds to download and keep up-to-date
      feeds: [
        '2002',
        '2003',
        '2004',
        '2005',
        '2006',
        '2007',
        '2008',
        '2009',
        '2010',
        '2011',
        '2012',
        '2013',
        '2014',
        '2015',
        '2016',
        '2017',
        '2018',
        '2019',
        'modified',
        'recent'
      ],

      // XXX not yet implemented XXX
      // Attempt to fetch all feeds between the last one listed in the `feeds` config
      // and the current year. E.g. if the last year list in `feeds` is 2019, but the
      // current year is 2022, also attempt to fetch and sync feeds for 2020, 2021
      // and 2022 if they exist.
      // includeCurrentYearlyFeeds: false,

      // fetch `${rootPath}-${feed}.json.gz`, if you have a private cache
      // you can override this to fetch from your private cache.
      rootPath: 'https://nvd.nist.gov/feeds/json/cve/1.0/nvdcve-1.0',

      // Default location where the json files are stored
      cacheDir: NVD.chooseDefaultCacheDir()
    };
    this.config = Object.assign({}, this.defaults, options);
  }

  static parseMetaFile (metaFile) {
    const lines = metaFile.split('\r\n');
    const result = {};
    for (const line of lines) {
      if (!line) {
        continue;
      }
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
      return path.join(process.env.XDG_CACHE_HOME, 'nvd');
    }
    return path.join(os.homedir(), '.cache', 'nvd');
  }

  // Download metafile and convert to an object
  static fetchMetaFile (ctx, done) {
    const metaPath = `${ctx.config.rootPath}-${ctx.feed}.meta`;
    request(metaPath, (error, response, body) => {
      if (error) {
        return done(error);
      }
      ctx.metadata = NVD.parseMetaFile(body);
      done(null, ctx);
    });
  }

  // Determine if local file matches the remote metadata, if it doesn't set
  // ctx.fetchRemote to true so the next function in the pipeline downloads
  // the latest file.
  static checkLocalFeedFile (ctx, done) {
    const localFeedFile = `${ctx.config.cacheDir}/nvdcve-1.0-${ctx.feed}.json`;
    const reader = fs.createReadStream(localFeedFile);
    const hash = crypto.createHash('sha256');
    hash.setEncoding('hex');

    reader.on('finish', () => {
      hash.end();
      const hashValue = hash.read().toUpperCase();
      ctx.fetchRemote = (hashValue !== ctx.metadata.sha256);
      console.log('checkLocalFeedFile', hashValue, ctx.metadata.sha256);
      done(null, ctx);
    });

    reader.on('error', (error) => {
      reader.close();
      if (error && error.code !== 'ENOENT') {
        console.error('Error: checkLocalFeedFile()', error);
        return done(error);
      }
      ctx.fetchRemote = true;
      done(null, ctx);
    });

    reader.pipe(hash);
  }

  // Download and cache the specific remote feed file, unzip it and write it to
  // disk. Only do this if ctx.fetchRemote is true (see checkLocalFeedFile)
  static fetchRemoteFeedFile (ctx, done) {
    if (!ctx.fetchRemote) {
      console.log(`skipping: ${ctx.config.cacheDir}/nvdcve-1.0-${ctx.feed}.json`);
      return done(null, ctx);
    }
    const gzip = zlib.createGunzip();
    const writer = fs.createWriteStream(`${ctx.config.cacheDir}/nvdcve-1.0-${ctx.feed}.json`);
    const httpStream = request(`${ctx.config.rootPath}-${ctx.feed}.json.gz`);

    httpStream.on('error', (error) => {
      console.error('Error: fetchRemoteFeedFile:httpStream', error);
      done(error);
    });

    gzip.on('error', (error) => {
      console.error('Error: fetchRemoteFeedFile:gzip',
        `fetchRemoteFeedFile:${ctx.config.cacheDir}/nvdcve-1.0-${ctx.feed}.json`, 
        `${ctx.config.rootPath}-${ctx.feed}.json.gz`,
        error);
      done(error);
    });

    writer.on('finish', () => {
      console.log('fetchRemoteFeedFile:writer.finish',
        `${ctx.config.cacheDir}/nvdcve-1.0-${ctx.feed}.json`);
      done(null, ctx);
    });

    httpStream.pipe(gzip).pipe(writer);
  }

  // Download feed metafile and download if remote differs from the local file
  static fetchFeedWaterfall (ctx, done) {
    waterfall([
      (next) => {
        next(null, ctx);
      },
      NVD.fetchMetaFile,
      NVD.checkLocalFeedFile,
      NVD.fetchRemoteFeedFile
    ], (error, ctx) => {
      if (!error && typeof ctx.progress === 'function') {
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
    // Node.js < 10 doesn't support `recursive: true` for mkdir
    if (parseInt(process.version.replace(/^v/,'').split('.')[0], 10) < 10) {
      try {
        console.warn('Warning: Node.js version > 10 recommended');
        mkDirByPathSync(ctx[0].config.cacheDir);
      } catch (e) {
        console.error(e);
        return next(e);
      }
      return next(null, ctx);
    }

    fs.mkdir(ctx[0].config.cacheDir, {recursive: true}, (error) => {
      if (error && error.code !== 'EEXIST') {
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
        config: this.config
      };
    });

    waterfall([
      (next) => {
        next(null, contexts);
      },
      NVD.createCacheDir,
      NVD.fetchFeedParallel
    ], (error, results) => {
      if (error) {
        return done(error, results);
      }
      done(null, results);
    });
  }

  search (id, done) {
    let found = false;
    let haystacksExausted = false;
    let failure = false;
    let year = false;
    const parts = id.split('-');
    const haystacks = this.config.feeds.slice();

    if (parts.length > 1) {
      year = parts[1];
    }

    const results = whilst(
      () => {
        return !found && !haystacksExausted && !failure;
      },

      (next) => {
        let results;
        let feedName;

        if (!haystacks.length) {
          haystacksExausted = true;
          next();
          return;
        }

        // search yearly feed for CVE first
        if (year && haystacks.indexOf(year) !== -1) {
          haystacks.splice(haystacks.indexOf(year), 1);
          feedName = year;
        } else {
          feedName = haystacks.pop();
        }

        const feedPath = `${this.config.cacheDir}/nvdcve-1.0-${feedName}.json`;
        const reader = fs.createReadStream(feedPath);
        const stream = JSONStream.parse('CVE_Items.*');

        reader.pipe(stream);

        reader.on('error', (error) => {
          failure = true;
          stream.end();
          reader.end();
          next(error, results);
        });

        stream.on('data', (data) => {
          if (data.cve.CVE_data_meta.ID === id) {
            found = true;
            results = data;
            stream.end();
          }
        });

        stream.on('end', () => {
          next(null, results);
        });

        stream.on('error', (error) => {
          failure = true;
          stream.end();
          reader.end();
          next(error, results);
        });
      },

      (error, data) => {
        done(error, {data, results});
      });
  }
};
