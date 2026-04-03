#!/usr/bin/env node
/**
 * 将项目自定义 fixture 格式转换为 koala 标准格式
 *
 * 用法: node scripts/convert-fixtures.js <fixtures-dir>
 *   扫描目录下所有 .json fixture，检测并转换非标准格式
 *
 * 转换规则:
 *   1. input.method / case name 前缀 → fn 字段
 *   2. expect.throws: true + expect.errorMessageContains → throws: "..."
 *   3. expect.throws: false → 移除 throws，保留其他 expect 字段
 *   4. input.scenario → 移除（dispatch 路由字段，wrapper 不需要）
 *   5. 自定义断言字段 → 转为 pattern 正则或保留（部分匹配）
 */

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/convert-fixtures.js <fixtures-dir>');
  process.exit(1);
}

function walkJson(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJson(full));
    } else if (entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

function extractFnFromName(name) {
  // "sendRoomMessage — throws when..." → "sendRoomMessage"
  // "constructor — throws..." → "constructor"
  const match = name.match(/^(\w+)\s*[—–-]\s*/);
  return match ? match[1] : null;
}

function convertCase(c) {
  const converted = { name: c.name };

  // 1. 提取 fn：优先 input.method，其次 case name 前缀
  const fn = c.input?.method || extractFnFromName(c.name);
  if (fn && fn !== 'constructor') {
    converted.fn = fn;
  }

  // 2. 清理 input：移除 scenario/method（dispatch 路由字段）
  if (c.input) {
    const cleanInput = { ...c.input };
    delete cleanInput.scenario;
    delete cleanInput.method;
    // deps 保留（wrapper 需要用来构造实例）
    converted.input = cleanInput;
  }

  // 3. 转换 expect
  if (c.expect) {
    if (c.expect.throws === true) {
      // throws: true + errorMessageContains → koala throws 字段
      converted.throws = c.expect.errorMessageContains || c.expect.errorCode || 'Error';
    } else if (c.expect.throws === false) {
      // 非抛出场景，移除 throws 相关字段，保留其他
      const cleanExpect = { ...c.expect };
      delete cleanExpect.throws;
      delete cleanExpect.errorCode;
      delete cleanExpect.errorMessageContains;

      // 转换自定义断言
      const koalaExpect = {};
      let hasCustom = false;

      for (const [key, val] of Object.entries(cleanExpect)) {
        if (key === 'resultLength' || key === 'resultTaskIds') {
          // 自定义断言 → 无法直接转换，标记为注释
          hasCustom = true;
          koalaExpect[`_custom_${key}`] = val;
        } else if (key.endsWith('Null') && val === true) {
          // memoryNull: true → 无法验证，跳过
          hasCustom = true;
        } else {
          koalaExpect[key] = val;
        }
      }

      if (Object.keys(koalaExpect).length > 0) {
        converted.expect = koalaExpect;
      }
      if (hasCustom) {
        converted._warning = '含自定义断言，需 wrapper 配合验证';
      }
    } else {
      // 普通 expect（没有 throws 字段）→ 直接保留
      converted.expect = c.expect;
    }
  }

  return converted;
}

function needsConversion(fixture) {
  if (!fixture.cases) return false;
  return fixture.cases.some(c =>
    c.expect?.throws === true ||
    c.expect?.throws === false ||
    c.expect?.errorMessageContains ||
    c.expect?.errorCode ||
    c.input?.scenario ||
    c.input?.method
  );
}

// 执行：支持传文件或目录
const stat = fs.statSync(dir);
const files = stat.isDirectory() ? walkJson(dir) : [dir];
let converted = 0;
let skipped = 0;

for (const file of files) {
  try {
    const content = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!needsConversion(content)) {
      skipped++;
      continue;
    }

    const result = {
      cases: content.cases.map(convertCase),
    };

    // 备份原文件
    const backupPath = file + '.bak';
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(file, backupPath);
    }

    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
    converted++;

    const warnings = result.cases.filter(c => c._warning).length;
    console.log(`✓ ${path.relative(dir, file)} (${result.cases.length} cases${warnings ? `, ${warnings} warnings` : ''})`);
  } catch (e) {
    console.error(`✗ ${path.relative(dir, file)}: ${e.message}`);
  }
}

console.log(`\nDone: ${converted} converted, ${skipped} skipped (already koala format)`);
if (converted > 0) {
  console.log('原文件已备份为 .bak，检查无误后可删除');
  console.log('\n⚠ 含 _warning 的 case 需要手动检查 wrapper 是否支持');
  console.log('⚠ fn=constructor 的 case 已跳过（需要特殊 wrapper 处理）');
}
