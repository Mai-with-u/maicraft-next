const fs = require('fs');
const path = require('path');

const distRoot = path.resolve(__dirname, '..', 'dist');

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && /\.(js|cjs|mjs)$/.test(entry.name)) {
      rewriteFile(full);
    }
  }
}

function toRelativeImport(filePath, aliasPath) {
  const withoutPrefix = aliasPath.replace(/^@\//, '');
  const target = path.join(distRoot, withoutPrefix);
  let relative = path.relative(path.dirname(filePath), target).replace(/\\/g, '/');
  if (!relative.startsWith('.')) relative = './' + relative;
  return relative;
}

function rewriteFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  content = content.replace(/require\((['"])@\/([^'"]+)\1\)/g, (_, quote, importPath) => {
    changed = true;
    return `require(${quote}${toRelativeImport(filePath, `@/${importPath}`)}${quote})`;
  });

  content = content.replace(/from\s+(['"])@\/([^'"]+)\1/g, (_, quote, importPath) => {
    changed = true;
    return `from ${quote}${toRelativeImport(filePath, `@/${importPath}`)}${quote}`;
  });

  content = content.replace(/import\((['"])@\/([^'"]+)\1\)/g, (_, quote, importPath) => {
    changed = true;
    return `import(${quote}${toRelativeImport(filePath, `@/${importPath}`)}${quote})`;
  });

  if (changed) {
    fs.writeFileSync(filePath, content);
    console.log(`rewrote aliases: ${path.relative(distRoot, filePath)}`);
  }
}

if (!fs.existsSync(distRoot)) {
  console.error('dist directory not found:', distRoot);
  process.exit(1);
}

walk(distRoot);
console.log('dist alias rewrite complete');
