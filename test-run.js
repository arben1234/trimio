const fs = require('fs');
const path = require('path');

// Mock DOM
global.window = {
  storage: {
    get: () => Promise.resolve({ value: null }),
    set: () => Promise.resolve()
  }
};
global.document = {
  getElementById: (id) => {
    return {
      style: {},
      querySelector: () => ({ style: {} }),
      querySelectorAll: () => [],
      addEventListener: () => {},
      classList: {
        add: () => {},
        remove: () => {},
        toggle: () => {}
      }
    };
  },
  querySelectorAll: () => [],
  addEventListener: () => {}
};
global.$ = (id) => global.document.getElementById(id);
global.location = { hash: '' };
global.navigator = { clipboard: {} };

// Mock default globals
global.DEFAULT_SERVICES = [];
global.DEFAULT_SLOTS = [];

try {
  const appJsCode = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  eval(appJsCode);
  console.log("Successfully ran eval of app.js with no immediate runtime errors!");
} catch (e) {
  console.error("Runtime error caught in app.js execution:", e);
}
