import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import type { Row } from './db.js';

const require=createRequire(import.meta.url);
const PdfPrinter=require('pdfmake') as new (fonts:Record<string,Record<string,string>>)=>{
  createPdfKitDocument(doc:TDocumentDefinitions):NodeJS.ReadableStream & {end():void};
};
const fontkit=require('@foliojs-fork/fontkit') as {openSync(path:string):{unitsPerEm:number;layout(text:string):{advanceWidth:number}}};
const root=dirname(require.resolve('@expo-google-fonts/cairo/package.json'));
const normal=join(root,'400Regular/Cairo_400Regular.ttf');
const bold=join(root,'700Bold/Cairo_700Bold.ttf');
const logo=fileURLToPath(new URL('../assets/invoice-logo.png',import.meta.url));
const printer=new PdfPrinter({Cairo:{normal,bold,italics:normal,bolditalics:bold}});
const fonts={normal:fontkit.openSync(normal),bold:fontkit.openSync(bold)};

// PDFKit's Arabic text can collapse spaces. Measure with the same embedded font and
// wrap before replacing spaces with NBSP. Long unbroken identifiers must wrap too.
function wrap(value:unknown,width:number,size=10,strong=false):{text:string}[] {
  const font=strong?fonts.bold:fonts.normal;
  const measure=(s:string)=>font.layout(s).advanceWidth/font.unitsPerEm*size;
  const output:string[]=[];
  // Use one digit convention: isolated Arabic-Indic digits are reversed by PDFKit.
  const paragraphs=String(value??'').replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/٫/g,'.').replace(/٬/g,',').replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g,'').replace(/\r\n?/g,'\n').split('\n');
  for(const paragraph of paragraphs){
    let line='';
    const push=()=>{if(line){output.push(line.replace(/ /g,'\u00a0'));line='';}};
    for(const token of paragraph.split(/\s+/).filter(Boolean)){
      if(measure(token)>width){
        push();let part='';
        for(const ch of Array.from(token)){if(part&&measure(part+ch)>width){output.push(part);part='';}part+=ch;}
        line=part;
      }else if(measure(line?`${line} ${token}`:token)>width){push();line=token;}
      else line=line?`${line} ${token}`:token;
    }
    push();if(!paragraph.trim())output.push('');
  }
  // PDFKit's font shaper reverses mixed Latin/number content inside Arabic. Keep
  // LTR runs intact in separate inline fragments, laid out in the RTL line's visual
  // order. This preserves codes such as ACME-37 and decimals such as 1.5.
  const arabic=/[\u0621-\u063a\u0641-\u064a\u066e-\u06d3\u06fa-\u06fc\u0750-\u077f\u08a0-\u08ff]/u;
  const ltr=/[+\-#]?[A-Za-z0-9٠-٩۰-۹][A-Za-z0-9٠-٩۰-۹@._,:/%+\-]*(?:[ \u00a0]+[+\-#]?[A-Za-z0-9٠-٩۰-۹][A-Za-z0-9٠-٩۰-۹@._,:/%+\-]*)*/gu;
  const inlines:{text:string}[]=[];
  output.forEach((line,index)=>{
    if(index)inlines.push({text:'\n'});
    if(!arabic.test(line)){inlines.push({text:line});return;}
    const parts:string[]=[];let pos=0;
    for(const match of line.matchAll(ltr)){
      if(match.index>pos)parts.push(line.slice(pos,match.index));
      parts.push(match[0]);pos=match.index+match[0].length;
    }
    if(pos<line.length)parts.push(line.slice(pos));
    inlines.push(...parts.reverse().map(part=>({text:part})));
  });
  return inlines.length?inlines:[{text:'—'}];
}
const text=(value:unknown,width:number,opts:{fontSize?:number;bold?:boolean;color?:string;alignment?:'left'|'center'|'right';margin?:[number,number,number,number];fillColor?:string}={}):Content=>({
  text:wrap(value,width,opts.fontSize??10,opts.bold??false),alignment:'right',...opts,
});
const n=(amount:number,decimals:number)=>new Intl.NumberFormat('en-US',{minimumFractionDigits:decimals,maximumFractionDigits:decimals}).format(amount);
const cash=(p:unknown)=>n(Number(p)/100,2);
const qty=(m:unknown)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:3}).format(Number(m)/1000);
const date=(t:unknown,zone:string)=>new Intl.DateTimeFormat('en-GB',{dateStyle:'short',timeStyle:'short',timeZone:zone}).format(Number(t)).replace(',','');
const tableLayout={hLineWidth:()=>0.5,vLineWidth:()=>0.5,hLineColor:()=> '#d7e0da',vLineColor:()=> '#d7e0da',paddingLeft:()=>5,paddingRight:()=>5,paddingTop:()=>5,paddingBottom:()=>5};
const hdr=(v:string,w:number)=>text(v,w-10,{bold:true,fontSize:9,alignment:'center',fillColor:'#e9f1ec'});
const numberCell=(v:string)=>({text:v,alignment:'center' as const,fontSize:10});

export type InvoicePdfData={record:Row;snapshot:Row|null;lines:Row[];events:(Row & {lines:Row[]})[];revision:number};
/** Original invoice plus explicitly dated corrections, never an invented per-invoice allocation of later receipts. */
export function invoicePdf(data:InvoicePdfData,timezone:string,generatedAt:number):Promise<Buffer> {
 const r=data.record;
 const c=data.snapshot??{customerName:r.currentName,phone:r.currentPhone,governorate:r.currentGovernorate,district:r.currentDistrict,village:r.currentVillage,warehouseName:r.currentWarehouse,repName:''};
 const widths=[90,80,70,224]; // PDFMake columns are LTR; the product is on the right.
 const table:Content[][]=[ [hdr(data.events.length?'القيمة قبل التصحيح':'القيمة',widths[0]),hdr('سعر الوحدة',widths[1]),hdr('الكمية',widths[2]),hdr('الصنف والعبوة',widths[3])] ];
 for(const l of data.lines)table.push([numberCell(cash(l.amount)),numberCell(cash(l.price)),text(`${qty(l.qty)} ${l.unit}`,widths[2]-10,{alignment:'center'}),text([l.name,l.unit,l.unitSize].filter(Boolean).join(' · '),widths[3]-10)]);
 const label=(name:string,value:unknown):Content=>({columns:[{text:wrap(value||'—',340),alignment:'right',width:'*'},{text:wrap(name,120,10,true),alignment:'right',width:130,bold:true,color:'#426351'}],columnGap:8,margin:[0,2,0,2]});
 const section=(title:string):Content=>text(title,480,{fontSize:12,bold:true,color:'#1f5a3d',margin:[0,12,0,5]});
 const content:Content[]=[
  {columns:[
    {table:{widths:[74],body:[[{image:logo,fit:[70,72],alignment:'center',margin:[2,4,2,4]}]]},layout:{defaultBorder:false,fillColor:()=> '#0a1b27'},width:82},
    {stack:[text('الهلب جروب',380,{fontSize:18,bold:true,color:'#153d53'}),
      text('فاتورة بيع',380,{fontSize:16,bold:true,color:'#153d53',margin:[0,3,0,2]}),
      text('فاتورة معتمدة من مجموعة الهلب جروب',380,{fontSize:9,color:'#597469'})],width:'*'}
  ],columnGap:12,margin:[0,0,0,12]},
  ...(data.events.length?[text('تنبيه: سُجّلت تصحيحات على هذه البيعة، وتفاصيلها بالأسفل.',480,{bold:true,color:'#9b381b',margin:[0,0,0,5]})]:[]),
  section('بيانات الفاتورة'),
  label('رقم الفاتورة',r.invoiceNumber),label('تاريخ البيع',date(r.createdAt,timezone)),
  label(data.snapshot?'العميل':'العميل (البيانات الحالية)',c.customerName),label('الهاتف',c.phone),
  label('العنوان',[c.governorate,c.district,c.village].filter(Boolean).join(' · ')),
  section(data.events.length?'الأصناف قبل التصحيح':'الأصناف'),
  {table:{headerRows:1,widths,body:table},layout:tableLayout},
  text('كل الأسعار والقيم بالجنيه المصري',480,{fontSize:9,color:'#597469',margin:[0,4,0,0]}),
  section('ملخص وقت البيع'),
  label(data.events.length?'الإجمالي قبل التصحيح':'الإجمالي',cash(r.total)),label('المدفوع وقت البيع',cash(r.paid)),label('الباقي وقت البيع',cash(Number(r.total)-Number(r.paid))),
  text('المبالغ تخص وقت البيع؛ الدفعات اللاحقة تُراجع في كشف حساب العميل.',480,{fontSize:9,color:'#597469',margin:[0,6,0,0]}),
 ];
 if(data.events.length){
  content.push(section('سجل تصحيحات البيعة'));
  for(const e of data.events){
   content.push(text('تصحيح مسجّل',480,{bold:true,fontSize:11,color:'#1f5a3d',margin:[0,8,0,2]}),
     label('مرجع التصحيح',e.id),label('تاريخ التصحيح',date(e.createdAt,timezone)),label('المسؤول',e.actorName),
     text('سبب التصحيح',480,{bold:true,margin:[0,4,0,2]}),text(e.reason,480,{margin:[0,0,0,4]}));
   for(const l of e.lines){
    content.push(text(l.name,480,{bold:true,margin:[0,4,0,2]}),
      label('الكمية المصححة',qty(l.corrected)),label('قيمة التخفيض',cash(l.amount)));
    if(l.stockKind && Number(l.returned)-Number(l.damaged||0)>0) content.push(label(l.stockKind==='error'?'لم تخرج والخصم خطأ':'مرتجع لمخزن الفاتورة',`${qty(Number(l.returned)-Number(l.damaged||0))} ${String(l.unit||'')}`));
    if(Number(l.damaged||0)>0) content.push(label(`مرتجع تالف إلى ${String(l.damagedWarehouseName||'مخزن التالف')}`,`${qty(l.damaged)} ${String(l.unit||'')}`));
   }
   if(e.cashKind) content.push(label(e.cashKind==='error'?'لم يُستلم وسُجّل خطأ':'رُدّ للعميل',cash(e.cash)));
  }
  content.push(section('القيمة الحالية بعد التصحيحات'),label('صافي قيمة الأصناف',cash(Number(r.total)-data.lines.reduce((sum,l)=>sum+Number(l.correctedAmount),0))));
 }
 // Generated time is not presented as a sale time; the sale date above is authoritative.
 void generatedAt;
 const doc:TDocumentDefinitions={pageSize:'A4',pageMargins:[38,30,38,42],defaultStyle:{font:'Cairo',fontSize:10,lineHeight:1.15},
  info:{title:`Invoice ${String(r.invoiceNumber)}`,subject:'Company sales invoice'},
  footer:(page:number,pages:number)=>({text:`${page} / ${pages}`,alignment:'center',fontSize:9,color:'#71857a',margin:[0,12,0,0]}),content};
 return new Promise((resolve,reject)=>{
  const stream=printer.createPdfKitDocument(doc),chunks:Buffer[]=[];
  stream.on('data',(chunk:Buffer)=>chunks.push(chunk));stream.on('end',()=>resolve(Buffer.concat(chunks)));stream.on('error',reject);stream.end();
 });
}
