const fs = require('fs');
const path = require('path');

const translations = JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n.json'), 'utf-8'));

function t(lang = 'ru', key, vars = {}) {
  const str = translations[lang]?.[key] || translations['ru']?.[key] || key;
  return str.replace(/\{\{(.*?)\}\}/g, (_, k) => vars[k.trim()] ?? '');
}

module.exports = { t };