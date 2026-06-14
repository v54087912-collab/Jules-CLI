const { applyPatch } = require('diff');

const diff = `--- /dev/null
+++ b/file.txt
@@ -0,0 +1,3 @@
+line 1
+line 2
+line 3`;

const localContent = `line 1
line 2
line 3`;

const forwardPatched = applyPatch(localContent, diff);
console.log('Result:', JSON.stringify(forwardPatched));
