const fs=require('fs');const
  p=JSON.parse(fs.readFileSync('package.json','utf8'));if(p.dependencies&&p.dependencies['json-database-st']){delete
  p.dependencies['json-database-st'];fs.writeFileSync('package.json',JSON.stringify(p,null,2));console.log('Removed self-dependency from
  package.json');}else{console.log('No self-dependency found');}
