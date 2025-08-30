var immutable = require('immutable');
const map = immutable.Map({ a: 1, b: 2, c: 3 });
const lazySeq = immutable.Seq(map);

immutable.List(['a']);