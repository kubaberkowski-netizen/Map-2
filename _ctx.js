const fs=require("fs");
const s=fs.readFileSync("src/app.template.html","utf8");
const [needle,before,after]=[process.argv[2],+(process.argv[3]||120),+(process.argv[4]||400)];
let i=0,n=0;
while((i=s.indexOf(needle,i))>=0 && n<6){
  console.log("\n===== match @"+i+" =====");
  console.log(s.slice(Math.max(0,i-before),i+needle.length+after));
  i+=needle.length;n++;
}
if(!n)console.log("NO MATCH for",needle);
