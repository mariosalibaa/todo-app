import ExcelJS from "file:///D:/vscode/georges-sheet/node_modules/exceljs/excel.js";
const wb=new ExcelJS.Workbook();
await wb.xlsx.readFile("D:/Dropbox/0. SHIFT/0. ACCOUNTING/0. payroll, timeline, worker/ziad arabe/accounting & working hours - ziad.xlsx");
const ws=wb.getWorksheet("accounting");
for(let r=2875;r<=2900;r++){
  const row=ws.getRow(r);
  const vals=[];
  for(let c=1;c<=10;c++){const v=row.getCell(c).value; vals.push(v&&v.result!==undefined?v.result:(v&&v.text!==undefined?v.text:v));}
  console.log(r, JSON.stringify(vals));
}
