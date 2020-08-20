# nvd-search ![Node.js Package](https://github.com/travispaul/node-nvd-search/workflows/Node.js%20Package/badge.svg)

Node module to fetch, cache, and search the NIS National Vulnerability Database.

## Usage

## new NVD(config);

Create a new instance of the NVD class, you may supply an optional config object.

### nvd.sync(callback, progress)

Sync the local cache with the remote NIST feeds.

If a `progress` function is supplied, it is called after each feed has been handled.

```
const NVD = require('nvd-search');
const nvd = new NVD();
nvd.sync((error, results) => {
  if (error) {
    return console.error(error);
  }
  // remote files synced, likely want
  // to call `nvd.search()` now
});
```

### nvd.search(id, callback)

Find a specific CVE within the local cached feeds.

```
nvd.search('CVE-2019-12780', (error, results) => {
  if (error) {
    return console.error(error);
  }
  console.log(results.data); // feed data
});
```

## Configuration Options

You can provide a configuration object to the constructor: `NVD()`.
The following options are honored:

### config.feeds

An array of strings, each representing a feed to download, cache, and search.
You likely don't want to change this option.

**Default:**

```
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
]
```

### config.schemaVersion

Feed schema version to use in paths, currently tested with versions 1.0 and 1.1

**Default:**

```
schemaVersion: '1.1'
```

### config.rootPath

The URL prefix to use when fetching remote feeds. You might want to change
this if you host your own local cache.

**Default:**

```
rootPath: 'https://nvd.nist.gov/feeds/json/cve/'
```

### config.cacheDir

The directory to use when caching the feeds locally.
If this is not supplied, the environment variable [XDG_CACHE_HOME](https://standards.freedesktop.org/basedir-spec/basedir-spec-latest.html)
is used if defined, otherwise the fallback of `~.cache/nvd` is used.

### config.fetchLimit

When fetching remote feeds, only fetch this many files in parallel.

**Default:**

```
fetchLimit: 2
```

### config.persistAll

Save all files fetched from rootPath, useful for mirroring the feeds.

**Default:**

```
persistAll: false
```

## See also

- [nvd-search-cli](https://github.com/travispaul/node-nvd-search-cli)
