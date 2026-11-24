const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.argv[2] || 'E:\\NovaMind-work';
const expected = {"main.js": "625a450e6f60f97587d5f39270c606332e7f6248a6a92c92be21996ef1856ac8", "renderer.js": "5310c07e9456b82058e32da00fec5417103cd4fe09805cc470a074d4f5f7e662", "preload.js": "d66896605f014aba6027eba6ecd1bf5273b0be33e27c5e5fd823ceaa1fba2e30"};
const replacement = {"main.js": "9f075305eaaffa43fa65a5af90910b34f01adcbebf85afb2fae4d6a896622cdb", "renderer.js": "5d04a0299551578bc8fab1e71ec2ef8e33b81a6f66b941aad21020779d99fe65", "preload.js": "6b453d547a04706bf352e873ba83cac50b7b205802e49456874b047d55e8f9d1"};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readTarget = name => path.join(root, 'src', name);
const source = name => path.join(__dirname, 'src', name);
try {
  const names = Object.keys(expected);
  const checks = names.map(name => ({name, current:hash(readTarget(name)), next:hash(source(name))}));
  for (const {name, current, next} of checks) {
    if (next !== replacement[name]) throw new Error('Pacote alterado ou incompleto: '+name);
    if (current !== expected[name] && current !== replacement[name]) throw new Error('Versao diferente de '+name+'. Envie o arquivo atual para adaptar a correcao. Nada foi alterado.');
  }
  const changed = checks.filter(item => item.current !== replacement[item.name]);
  if (!changed.length) { console.log('Atualizacao ja instalada.'); process.exit(0); }
  const backup = path.join(root, 'backup-rana-'+new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(backup, {recursive:true});
  for (const {name} of changed) fs.copyFileSync(readTarget(name), path.join(backup,name));
  try {
    for (const {name} of changed) {
      const temp=readTarget(name)+'.rana-'+crypto.randomUUID()+'.tmp';
      try { fs.copyFileSync(source(name),temp); fs.renameSync(temp,readTarget(name)); }
      finally { if(fs.existsSync(temp)) fs.unlinkSync(temp); }
      if(hash(readTarget(name))!==replacement[name]) throw new Error('Falha na verificacao de '+name);
    }
  } catch (err) {
    for (const {name} of changed) fs.copyFileSync(path.join(backup,name),readTarget(name));
    throw err;
  }
  console.log('Atualizacao instalada. Backup: '+backup);
} catch (err) { console.error(err.message); process.exitCode=1; }