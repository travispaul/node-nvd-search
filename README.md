# nvd

Node module to fetch, cache, and search the NIS National Vulnerability Database.

## Usage

### nvd.sync

Sync the local cache with the remote NIST feeds.

```
const NVD = require('nvd');
const nvd = NVD();
nvd.sync((error) => {
  if (error) {
    return console.error(error);
  }
  // remote files synced, likely want
  // to call `nvd.search()` now
});
```

### nvd.search

Find a specific CVE within the local cached feeds.

```
nvd.search('CVE-2019-12780', (error, results) => {
  if (error) {
    return console.error(error);
  }
  console.log(results.data); // feed data
});
```