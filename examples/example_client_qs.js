let qs = require('qs');
let b = qs.parse('a[]=3&b=4&c=5');
let c = qs.stringify(b);
