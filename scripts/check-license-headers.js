/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

const fs = require('fs');
const path = require('path');

const TARGET_DIRS = [
  'logger/src',
  'tracing-types/src',
  'sep10-auth/src',
  'sanctions-oracle/src',
  'horizon-listener/src',
  'backoff/src',
  'metrics/src',
  'tracing/src',
];

const REQUIRED_HEADER_PATTERNS = [
  /Copyright \(c\) \d{4} stellar-compliance-kit/i,
  /SPDX-License-Identifier: MIT/i,
];

function getAllSourceFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      getAllSourceFiles(filePath, fileList);
    } else if (/\.(ts|js|tsx|jsx)$/.test(file)) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

let missingCount = 0;
const rootDir = path.resolve(__dirname, '..');

for (const targetDir of TARGET_DIRS) {
  const fullDirPath = path.join(rootDir, targetDir);
  const files = getAllSourceFiles(fullDirPath);
  for (const file of files) {
    const relativePath = path.relative(rootDir, file);
    const content = fs.readFileSync(file, 'utf8');
    const hasHeader = REQUIRED_HEADER_PATTERNS.every((pattern) => pattern.test(content));
    if (!hasHeader) {
      console.error(`❌ Missing license header: ${relativePath}`);
      missingCount++;
    }
  }
}

if (missingCount > 0) {
  console.error(`\nFailed: ${missingCount} source file(s) missing required license header.`);
  process.exit(1);
}

console.log('✅ All source files carry the required license header.');
process.exit(0);
