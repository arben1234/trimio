const fs = require('fs');
const path = require('path');
const Terser = require('terser');

const appJsPath = path.join(__dirname, 'js', 'app.js');
const minJsPath = path.join(__dirname, 'js', 'app.min.js');

async function runBuild() {
  try {
    let code = fs.readFileSync(appJsPath, 'utf8');

    // Anti-debugging and code protection scripts to inject at the top of production code
    const protectionHeader = `
// ==========================================
// SECURITY & COPYRIGHT PROTECTION BLOCK
// ==========================================
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (
    e.key === 'F12' ||
    (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) ||
    (e.ctrlKey && e.key === 'U')
  ) {
    e.preventDefault();
    return false;
  }
});
(function() {
  const check = function() {
    (function(a) {
      (function() {
        const b = function() {
          let c = new Date();
          debugger;
          return new Date() - c > 80;
        };
        if (b()) {
          document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-weight:bold;color:#ef4444;font-size:18px;text-align:center;padding:20px;background:#f9fafb;">Accesso protetto - Strumenti sviluppatore rilevati. I tentativi di ispezione del codice sono vietati.</div>';
        }
      })();
    })();
  };
  setInterval(check, 1000);
})();
\n`;

    const fullCode = protectionHeader + code;

    console.log('Minifying and mangling code with Terser...');
    const result = await Terser.minify(fullCode, {
      compress: {
        dead_code: true,
        drop_console: true, // Drop all console logs to prevent exposing database keys/URLs
        drop_debugger: false, // KEEP debugger statement since it is our anti-debug check!
        global_defs: {
          DEBUG: false
        }
      },
      mangle: {
        toplevel: true
      },
      format: {
        comments: false
      }
    });

    if (result.error) {
      throw result.error;
    }

    fs.writeFileSync(minJsPath, result.code, 'utf8');
    console.log(`Successfully built, minified, and protected js/app.min.js (${fs.statSync(minJsPath).size} bytes)`);
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

runBuild();
