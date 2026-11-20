const fs = require('fs');
const file = '/home/raj/Communets-E-commerce-Admin/Add_products_Microservice/frontend/src/components/BulkImportPage.jsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace("{ key: 'ean', label: 'SKU / EAN', required: true }", "{ key: 'ean', label: 'SKU / EAN', required: false }");

content = content.replace(/function EanBadge/g, "function StatusBadge");

content = content.replace(/\/\/ EAN validation state([\s\S]*?)const \[eanCheckDone, setEanCheckDone\] = useState\(false\);/, 
`  // Code validation state
  const [codeStatuses, setCodeStatuses] = useState([]); 
  const [codeDbMatches, setCodeDbMatches] = useState({});
  const [eanCheckDone, setEanCheckDone] = useState(true);`); // keep eanCheckDone as always true to avoid editing the lower JSX blocks too much

content = content.replace(/const eanCount = \{\};([\s\S]*?)setCodeStatuses\(cStatuses\);/,
`const cStatuses = products.map(p => {
      const c = (p.communetsCode || '').toString().trim().toUpperCase();
      if (!c) return 'auto';

      if (codeDbMatches[c]) {
        return codeDbMatches[c].isMine ? 'duplicate-db-mine' : 'duplicate-db-global';
      }
      return 'ok';
    });
    setCodeStatuses(cStatuses);`);

content = content.replace(/\[products, eanDbMatches, codeDbMatches, phase\]\);/, `[products, codeDbMatches, phase]);`);

content = content.replace(/\/\/ Batch EAN check against DB([\s\S]*?)setEanCheckDone\(true\);/, `setEanCheckDone(true);`);

content = content.replace(/setEanStatuses\(\[\]\);\n    setEanDbMatches\(\{\}\);\n    setEanCheckDone\(false\);/, `setEanCheckDone(false);`);

content = content.replace(/setEanStatuses\(prev => prev.filter\(\(_, i\) => i !== index\)\);/, ``);

content = content.replace(/const handleEanBlur = async \(idx\) => \{([\s\S]*?)\};\n\n  const handleCodeBlur/g, "const handleCodeBlur");

content = content.replace(/if \(json\.exists && json\.product\?\.productOGCode\) \{([\s\S]*?)\}/, "");

content = content.replace(/const missingCount    = eanStatuses\.filter\(s => s === 'missing'\)\.length;\n    const dupFileCount    = eanStatuses\.filter\(s => s === 'duplicate-file'\)\.length;\n    const dupDbMineCount  = eanStatuses\.filter\(s => s === 'duplicate-db-mine'\)\.length;\n    const dupDbGlobalCount= eanStatuses\.filter\(s => s === 'duplicate-db-global'\)\.length;\n    const readyCount      = eanStatuses\.filter\(s => s === 'ok'\)\.length;/,
`const missingCount = 0; const dupFileCount = codeStatuses.filter(s => s === 'duplicate-file').length; const dupDbMineCount = codeStatuses.filter(s => s === 'duplicate-db-mine').length; const dupDbGlobalCount = codeStatuses.filter(s => s === 'duplicate-db-global').length; const readyCount = codeStatuses.filter(s => s === 'ok').length;`);

content = content.replace(/\{dupDbMineCount > 0 && \([\s\S]*?\}\)\]\);[\s\S]*?return \([\s\S]*?if \(eanStatuses\[i\] !== 'duplicate-db-mine'\) return null;[\s\S]*?const match = eanDbMatches\[\(p.ean \|\| ''\).toString\(\).trim\(\)\];/, 
`{dupDbMineCount > 0 && (
          <div className="mb-4 p-4 bg-amber-50 border border-amber-300 rounded-xl text-sm">
            <div className="font-bold text-amber-800 mb-2">🔄 Overriding Existing Products:</div>
            <p className="text-xs text-amber-700 mb-3 leading-relaxed">The following rows already exist in your catalog. By keeping them, you will OVERWRITE their prices and stock. If you do not want to override, please delete the row.</p>
            <ul className="space-y-1">
              {products.map((p, i) => {
                if (codeStatuses[i] !== 'duplicate-db-mine') return null;
                const match = codeDbMatches[(p.communetsCode || '').toString().trim().toUpperCase()];`);

content = content.replace(/\{dupDbGlobalCount > 0 && \([\s\S]*?\}\)\]\);[\s\S]*?return \([\s\S]*?if \(eanStatuses\[i\] !== 'duplicate-db-global'\) return null;[\s\S]*?const ean = \(p.ean \|\| ''\).toString\(\).trim\(\);/,
`{dupDbGlobalCount > 0 && (
          <div className="mb-4 p-4 bg-red-50 border border-red-300 rounded-xl text-sm">
            <div className="font-bold text-red-800 mb-2">⛔ Code Pre-exists with another vendor (Blocked):</div>
            <p className="text-xs text-red-700 mb-3 leading-relaxed">These Communets Codes are already registered directly to another vendor. You must remove these rows.</p>
            <ul className="space-y-1">
              {products.map((p, i) => {
                if (codeStatuses[i] !== 'duplicate-db-global') return null;
                const ean = (p.communetsCode || '').toString().trim().toUpperCase();`);

content = content.replace(/\{dupFileCount > 0 && \([\s\S]*?\}\)\]\);[\s\S]*?return \([\s\S]*?duplicate EAN numbers within this file/, 
`{dupFileCount > 0 && (
          <div className="mb-4 p-4 bg-red-50 border border-red-300 rounded-xl text-sm">
            <div className="font-bold text-red-800 mb-2">🔁 Duplicate Codes within this file`);

content = content.replace(/const eSt = eanStatuses\[idx\] \|\| 'ok';/, `const eSt = 'ok';`);
content = content.replace(/const eanSt = eanStatuses\[idx\] \|\| 'ok';/, `const eanSt = 'ok';`);

content = content.replace(/onBlur=\{\(\) => handleEanBlur\(idx\)\}/, "");
content = content.replace(/<EanBadge\n *status=\{eanSt\}[\s\S]*?\/>/, "");
content = content.replace(/EanBadge/g, "StatusBadge");
content = content.replace(/<StatusBadge\n *status=\{codeSt\}[\s\S]*?\/>/, `<StatusBadge status={codeSt} detail={codeDbMatches[(prod.communetsCode || '').toString().trim().toUpperCase()]} onView={() => { const match = codeDbMatches[(prod.communetsCode || '').toString().trim().toUpperCase()]; if (match) window.open('/products?search=' + match.communetCode, '_blank'); }} />`);
content = content.replace(/<th className="p-2 text-left w-32">EAN \/ SKU <span className="text-red-500">\*<\/span><\/th>/, `<th className="p-2 text-left w-32">EAN / SKU (Optional)</th>`);

content = content.replace(/<th className="p-2 text-left w-10">E.Status<\/th>\n/, "");
content = content.replace(/<td className="p-1 text-center">\n *<\/td>\n/, "");


fs.writeFileSync(file, content);
console.log('Successfully patched BulkImportPage.jsx');
