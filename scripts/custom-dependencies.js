const fs = require('fs');

function mergeJsonFiles(original, customDependencies, outputFile) {
  fs.readFile(original, 'utf8', (err, data1) => {
    if (err) {
      console.error(`Error reading ${original}:`, err);
      return;
    }

    fs.readFile(customDependencies, 'utf8', (err, data2) => {
      if (err) {
        console.error(`Error reading ${customDependencies}:`, err);
        return;
      }

      const json1 = JSON.parse(data1);
      const json2 = JSON.parse(data2);
      const mergedJson = {
        ...json1, dependencies: {
          ...json1.dependencies,
          ...json2.dependencies
        }
      };
      if (mergedJson.workspaces !== undefined) {
        mergedJson.workspaces = [
          ...mergedJson.workspaces.map((workspace) => {
            return "../" + workspace;
          })
        ];
      }

      let dir = '.temp_custom_deps';
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
      }
      fs.writeFile(outputFile, JSON.stringify(mergedJson, null, 2), (err) => {
        if (err) {
          console.error(`Error writing ${outputFile}:`, err);
          return;
        }

        console.log(`Successfully merged ${original} and ${customDependencies} into ${outputFile}`);
      });
    });
  });
}

const inputFile1 = 'package.json';
const inputFile2 = 'custom-dependencies.json';
const outputFile = '.temp_custom_deps/package.json';

mergeJsonFiles(inputFile1, inputFile2, outputFile);