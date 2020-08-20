const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream');
const JSONStream = require('JSONStream');
const request = require('request');
const waterfall = require('async/waterfall');
const queue = require('async/queue');
const whilst = require('async/whilst');

module.exports = class NVD {

  constructor(options = {}) {
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
        '2020',
        'modified',
        'recent'
      ],

      // XXX not yet implemented XXX
      // Attempt to fetch all feeds between the last one listed in the `feeds` config
      // and the current year. E.g. if the last year list in `feeds` is 2019, but the
      // current year is 2022, also attempt to fetch and sync feeds for 2020, 2021
      // and 2022 if they exist.
      // includeCurrentYearlyFeeds: false,

      schemaVersion: '1.1',

      // fetch `${rootPath}-${feed}.json.gz`, if you have a private cache
      // you can override this to fetch from your private cache.
      rootPath: 'https://nvd.nist.gov/feeds/json/cve/',

      // Default location where the json files are stored
      cacheDir: NVD.chooseDefaultCacheDir(),

      // When fetching remote feeds, only fetch this many files in parallel
      fetchLimit: 2,

      // Save all files fetched from rootPath, useful for mirroring the feeds
      persistAll: false

    };

    this.config = Object.assign({}, this.defaults, options);

    if (['1.0', '1.1'].indexOf(this.config.schemaVersion) === -1) {
      console.warning('Warning: NIST feed schema version "%s" has not been tested', this.config.schemaVersion);
    }

    this.config.rootPath = `${this.config.rootPath}${this.config.schemaVersion}/nvdcve-${this.config.schemaVersion}`;
  }

  static parseMetaFile(metaFile) {
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

      if (ctx.config.persistAll) {
        const filePath = `${ctx.config.cacheDir}/nvdcve-${ctx.config.schemaVersion}-${ctx.feed}.meta`;
        fs.writeFile(filePath, body, (error) => {
          if (error) {
            done(error);
          } else {
            done(null, ctx);
          }
        });
      } else {
        done(null, ctx);
      }
    });
  }

  // Determine if local file matches the remote metadata, if it doesn't set
  // ctx.fetchRemote to true so the next function in the pipeline downloads
  // the latest file.
  static checkLocalFeedFile (ctx, done) {
    const localFeedFile = `${ctx.config.cacheDir}/nvdcve-${ctx.config.schemaVersion}-${ctx.feed}.json`;
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

    if (ctx.config.persistAll) {
      waterfall([
        // write the gzip'd file to disk
        (next) => {
          pipeline(
            request(`${ctx.config.rootPath}-${ctx.feed}.json.gz`),
            fs.createWriteStream(`${ctx.config.cacheDir}/nvdcve-${ctx.config.schemaVersion}-${ctx.feed}.json.gz`),
            (error) => {
              if (error) {
                next(error);
              } else {
                next(null, ctx);
              }
            }
          );
        },
        // gunzip the file for use
        (ctx, next) => {
          pipeline(
            fs.createReadStream(`${ctx.config.cacheDir}/nvdcve-${ctx.config.schemaVersion}-${ctx.feed}.json.gz`),
            zlib.createGunzip(),
            fs.createWriteStream(`${ctx.config.cacheDir}/nvdcve-${ctx.config.schemaVersion}-${ctx.feed}.json`),
            (error) => {
              if (error) {
                next(error);
              } else {
                next(null, ctx);
              }
            }
          );
        },
      ], (error, ctx) => {
        if (error) {
          return done(error);
        }
        done(null, ctx);
      });

    } else {
      pipeline(
        request(`${ctx.config.rootPath}-${ctx.feed}.json.gz`),
        zlib.createGunzip(),
        fs.createWriteStream(`${ctx.config.cacheDir}/nvdcve-${ctx.config.schemaVersion}-${ctx.feed}.json`),
        (error) => {
          if (error) {
            done(error);
          } else {
            done(null, ctx);
          }
        }
      );
    }
  }

  // download feed metafile and download if remote differs from the local file
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
    const completed = [];

    const fetchQueue = queue(NVD.fetchFeedWaterfall, contexts[0].config.fetchLimit);

    fetchQueue.error((error, task) => {
      console.error('queue task experienced an error', task);
      done(error);
    });

    fetchQueue.push(contexts, (error, task) => {
      if (error) {
        console.error('queue push experienced an error', error);
        return done(error);
      }
      if (task.config) {
        delete task.config;
      }
      completed.push(task);
    });

    fetchQueue.drain(() => {
      done(null, completed);
    });
  }

  // Create the configured cache directory
  static createCacheDir (ctx, next) {
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
    let results;
    const parts = id.split('-');
    const haystacks = this.config.feeds.slice();

    if (parts.length > 1) {
      year = parts[1];
    }

    whilst(
      (next) => {
        next(null, !found && !haystacksExausted && !failure);
      },

      (next) => {

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

        const feedPath = `${this.config.cacheDir}/nvdcve-${this.config.schemaVersion}-${feedName}.json`;
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
