// Runs automatically after: npm install -g @sirtheo/claude-switch
import('./dist/bin/setup.js').catch((e) => {
  console.log('claude-switch: postinstall skipped:', e.message);
});
