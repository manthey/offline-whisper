const https = require('https');

function wrapArguments(args) {
  let urlStr = '';
  let options = {};
  let callbackIndex = -1;

  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    urlStr = args[0].toString();
    if (typeof args[1] === 'object' && args[1] !== null) {
      options = args[1];
      callbackIndex = 2;
    } else {
      callbackIndex = 1;
    }
  } else if (typeof args[0] === 'object' && args[0] !== null) {
    options = args[0];
    urlStr = options.hostname || options.host || '';
    callbackIndex = 1;
  }

  if (urlStr.includes('github.com')) {
    options.headers = options.headers || {};

    const token = process.env.GITHUB_TOKEN;
    if (token && !options.headers['Authorization'] && !options.headers['authorization']) {
      options.headers['Authorization'] = `token ${token}`;
    }
  }

  const newArgs = [...args];
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    newArgs[1] = options;
  } else {
    newArgs[0] = options;
  }
  return newArgs;
}

const originalGet = https.get;
https.get = function (...args) {
  return originalGet.apply(this, wrapArguments(args));
};

const originalRequest = https.request;
https.request = function (...args) {
  return originalRequest.apply(this, wrapArguments(args));
};
