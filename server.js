// E-commerce with Server-Side Rendering: every page is built as HTML on the server (Express) and sent ready to display.
const express=require('express'),Database=require('better-sqlite3'),crypto=require('crypto'),path=require('path'),fs=require('fs');
// Load a local .env file if present (for running on your own computer; on Render use the Environment tab instead)
try{for(const l of fs.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!(m[1] in process.env))process.env[m[1]]=m[2].replace(/^["']|["']$/g,'')}}catch(e){}
const SHOP=process.env.SHOP_NAME||'Mekong Shop',PROD=process.env.NODE_ENV=='production',PORT=process.env.PORT||3000;
const db=new Database(process.env.DB_PATH||path.join(__dirname,'shop.db'));db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,description TEXT,price REAL NOT NULL,stock INTEGER NOT NULL DEFAULT 0,image_url TEXT,status TEXT NOT NULL DEFAULT 'active',category TEXT NOT NULL DEFAULT 'General',purchase_price REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,token TEXT UNIQUE,customer_name TEXT,email TEXT,phone TEXT,address TEXT,total REAL,payment TEXT DEFAULT 'KHQR',created_at TEXT);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER,product_id INTEGER,name TEXT,price REAL,qty INTEGER);
CREATE TABLE IF NOT EXISTS carts(cid TEXT,product_id INTEGER,qty INTEGER,PRIMARY KEY(cid,product_id));
CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY,name TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,email TEXT NOT NULL,created INTEGER NOT NULL);`);
try{db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'General'")}catch(e){}
try{db.exec('ALTER TABLE products ADD COLUMN purchase_price REAL NOT NULL DEFAULT 0')}catch(e){}
if(!db.prepare('SELECT COUNT(*) c FROM products').get().c){const ins=db.prepare('INSERT INTO products(name,description,price,stock,image_url,category,purchase_price) VALUES(?,?,?,?,?,?,?)');
 [['Laptop Pro 15','Fast 15-inch laptop with 16GB RAM, 512GB SSD and a sharp Retina display. Great for study, work and design.',999,5,'laptop','Electronics',780],['Wireless Earbuds','Noise-cancelling earbuds with a charging case that has a touch display. Up to 20 hours of battery in total.',45,30,'earbuds','Electronics',28],['Phone Case','Shock-proof silicone case with sparkly 3D flower decoration. Fits most modern phones.',9.5,100,'case','Accessories',4],['Cotton T-Shirt','Soft 180gsm classic cotton T-shirt. Comfortable for every day, available in five colours.',14,40,'tshirt','Clothing',7],['Running Shoes','Lightweight running shoes with a cushioned sole and a grippy outsole for roads and trails.',65,12,'shoes','Clothing',38],['Kampot Pepper 100g','Famous Cambodian fermented Kampot black pepper, vacuum packed to keep it fresh. 100g.',6,60,'pepper','Food',3],['Coffee Beans 500g','Medium roast whole coffee beans, locally grown and small-batch roasted. 500g.',18,3,'coffee','Food',11],['Backpack','Water-resistant travel backpack with a laptop sleeve and many compartments for your essentials.',32,20,'backpack','Accessories',19]].forEach(p=>ins.run(p[0],p[1],p[2],p[3],'/img/'+p[4]+'.webp',p[5],p[6]))}

try{db.exec('ALTER TABLE orders ADD COLUMN payment_status TEXT')}catch(e){}
db.exec(`CREATE TABLE IF NOT EXISTS payments(ref TEXT PRIMARY KEY,cid TEXT,total REAL,amount REAL,qr TEXT,md5 TEXT,expires INTEGER,created INTEGER,order_id INTEGER);`);
/* ---------- helpers ---------- */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),M=n=>'$'+Number(n).toFixed(2),r2=n=>Math.round(n*100)/100;
const int=(v,d=0)=>{const n=parseInt(v,10);return Number.isFinite(n)?n:d};
const cookie=(req,k)=>(req.headers.cookie||'').split(';').map(s=>s.trim().split('=')).find(a=>a[0]==k)?.[1];
const setCookie=(res,k,v,o)=>res.append('Set-Cookie',`${k}=${v}; HttpOnly; Path=/; ${o}${PROD?'; Secure':''}`);
const fmt=iso=>new Date(iso).toLocaleString('en-GB',{timeZone:process.env.SHOP_TZ||'Asia/Phnom_Penh',dateStyle:'medium',timeStyle:'short'});
const flash=req=>req.query.msg?`<p class="flash" role="status">${esc(req.query.msg)}</p>`:'';
const stockTxt=s=>s<=0?'<span class="bad">Out of stock</span>':s<=5?`<span class="warn">Only ${s} left</span>`:'<span class="ok">In stock</span>';
const cartItems=cid=>db.prepare("SELECT p.*,c.qty FROM carts c JOIN products p ON p.id=c.product_id WHERE c.cid=? AND p.status='active' ORDER BY p.id").all(cid);
const sum=it=>r2(it.reduce((a,i)=>a+i.price*i.qty,0));
function mergeGuestCart(guestCid,email){const key='u:'+email;if(guestCid===key)return;
 for(const i of db.prepare('SELECT product_id,qty FROM carts WHERE cid=?').all(guestCid)){
  const stock=db.prepare('SELECT stock FROM products WHERE id=?').get(i.product_id)?.stock||0;
  const have=db.prepare('SELECT qty FROM carts WHERE cid=? AND product_id=?').get(key,i.product_id)?.qty||0;
  const qty=Math.min(stock,have+i.qty);
  if(qty>0)db.prepare('INSERT INTO carts VALUES(?,?,?) ON CONFLICT(cid,product_id) DO UPDATE SET qty=excluded.qty').run(key,i.product_id,qty)}
 db.prepare('DELETE FROM carts WHERE cid=?').run(guestCid)}
const khqrImg=()=>fs.existsSync(path.join(__dirname,'public','khqr.png'))?'/khqr.png':'/khqr-placeholder.svg';

/* ---------- accounts & sessions ---------- */
const pwHash=(pw,salt)=>crypto.scryptSync(String(pw),salt,32).toString('hex');
const SESSION_MS=288e5;
function startSession(res,email){const tk=crypto.randomBytes(24).toString('hex');
 db.prepare('INSERT INTO sessions(token,email,created) VALUES(?,?,?)').run(tk,email,Date.now());
 setCookie(res,'sid',tk,'SameSite=Lax; Max-Age=28800');return tk}
function loadUser(req){const t=cookie(req,'sid'),s=t&&db.prepare('SELECT * FROM sessions WHERE token=?').get(t);
 if(!s||Date.now()-s.created>SESSION_MS)return null;
 return db.prepare('SELECT email,name,role FROM users WHERE email=?').get(s.email)||null}
const requireAdmin=(req,res,next)=>req.user?.role=='admin'?next():res.redirect('/login?msg='+encodeURIComponent('Admins only')+'&next=/admin/dashboard');
(function seedAdmin(){
 if(db.prepare("SELECT 1 FROM users WHERE role='admin'").get())return;
 const email=(process.env.ADMIN_USER||'admin').includes('@')?process.env.ADMIN_USER:(process.env.ADMIN_USER||'admin')+'@'+SHOP.toLowerCase().replace(/[^a-z0-9]+/g,'')+'.local';
 const pass=process.env.ADMIN_PASSWORD||'admin123';
 if(!process.env.ADMIN_PASSWORD)console.warn('WARNING: default admin password in use. Set ADMIN_PASSWORD before going public.');
 const salt=crypto.randomBytes(16).toString('hex');
 db.prepare('INSERT INTO users(email,name,salt,hash,role) VALUES(?,?,?,?,?)').run(email,'Admin',salt,pwHash(pass,salt),'admin');
 console.log('Admin account ready:',email)})();

const page=(req,title,body,head='')=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | ${esc(SHOP)}</title><link rel="stylesheet" href="/style.css">${head}</head><body>
<header><div class="wrap"><a class="brand" href="/">${esc(SHOP)}</a><nav><a href="/">Home</a><a href="/cart">Cart (${req.cartCount})</a>${req.user?(req.user.role=='admin'?`<a href="/admin/dashboard">Admin panel</a>`:`<a href="/my-orders">My Orders</a>`)+`<form method="post" action="/logout" style="margin:0"><button>Log out (${esc(req.user.name)})</button></form>`:`<a href="/login">Log in</a>`}</nav></div></header><main class="wrap">${flash(req)}${body}</main><footer class="wrap">&copy; ${esc(SHOP)}</footer></body></html>`;
const apage=(req,title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | Admin</title><link rel="stylesheet" href="/style.css"></head><body>
<header><div class="wrap"><a class="brand" href="/admin/dashboard">${esc(SHOP)} Admin</a><nav><a href="/admin/dashboard">Dashboard</a><a href="/admin/products">Products</a><a href="/admin/orders">Order history</a><a href="/" target="_blank" rel="noopener">View shop</a><form method="post" action="/logout" style="margin:0"><button>Log out</button></form></nav></div></header><main class="wrap">${flash(req)}${body}</main></body></html>`;

const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});next()});
app.use(express.static(path.join(__dirname,'public'),{maxAge:'1h'}));app.use(express.urlencoded({extended:false,limit:'20kb'}));
app.use((req,res,next)=>{let c=cookie(req,'cid');if(!/^[a-f0-9]{32}$/.test(c||'')){c=crypto.randomBytes(16).toString('hex');setCookie(res,'cid',c,'SameSite=Lax; Max-Age=2592000')}
 req.cid=c;req.user=loadUser(req);req.ck=req.user?'u:'+req.user.email:c;req.cartCount=db.prepare('SELECT COALESCE(SUM(qty),0) n FROM carts WHERE cid=?').get(req.ck).n;next()});

/* ---------- PUBLIC PAGES ---------- */
const card=p=>`<article class="card"><a href="/product/${p.id}"><img src="${esc(p.image_url||'/img/none.svg')}" alt="${esc(p.name)}" loading="lazy"></a><h3><a href="/product/${p.id}">${esc(p.name)}</a></h3><p class="mut">${esc((p.description||'').slice(0,90))}${(p.description||'').length>90?'…':''}</p><div class="price">${M(p.price)}</div><div>${stockTxt(p.stock)}</div>
<div class="row"><a class="btn ghost" href="/product/${p.id}">View Details</a><form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}"><input type="hidden" name="qty" value="1"><button ${p.stock>0?'':'disabled'}>Add to Cart</button></form></div></article>`;
app.get('/',(req,res)=>{const q=String(req.query.q||'').trim(),cat=String(req.query.cat||'').trim(),max=Number(req.query.max),sort=String(req.query.sort||'new');
 const cats=db.prepare("SELECT DISTINCT category FROM products WHERE status='active' ORDER BY category").all().map(r=>r.category);
 const where=["status='active'"],args=[];
 if(q){where.push('(name LIKE ? OR description LIKE ?)');args.push('%'+q+'%','%'+q+'%')}
 if(cat){where.push('category=?');args.push(cat)}
 if(Number.isFinite(max)&&max>=0){where.push('price<=?');args.push(max)}
 const order={new:'id DESC',low:'price ASC',high:'price DESC'}[sort]||'id DESC';
 const l=db.prepare(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args);
 const qs=k=>esc(k=='q'?q:k=='cat'?cat:k=='max'?(Number.isFinite(max)?max:''):sort);
 const bar=`<form class="bar" method="get" action="/"><input type="search" name="q" placeholder="Search products" aria-label="Search" value="${qs('q')}">
<select name="cat" aria-label="Category"><option value="">All categories</option>${cats.map(c=>`<option value="${esc(c)}" ${cat==c?'selected':''}>${esc(c)}</option>`).join('')}</select>
<input type="number" name="max" min="0" step="0.01" placeholder="Max price $" aria-label="Max price" value="${qs('max')}" style="width:130px">
<select name="sort" aria-label="Sort"><option value="new" ${sort=='new'?'selected':''}>Newest</option><option value="low" ${sort=='low'?'selected':''}>Price: low to high</option><option value="high" ${sort=='high'?'selected':''}>Price: high to low</option></select>
<button class="btn ghost">Apply</button></form>`;
 res.send(page(req,'Home',`<h1>Our products</h1>${bar}<div class="grid">${l.map(card).join('')||'<p>No products match. Clear a filter and try again.</p>'}</div>`,`<meta name="description" content="Shop online at ${esc(SHOP)}">`))});

app.get('/product/:id',(req,res)=>{const p=db.prepare("SELECT * FROM products WHERE id=? AND status='active'").get(int(req.params.id));if(!p)return notFound(req,res);
 const url=(process.env.BASE_URL||`${req.protocol}://${req.get('host')}`)+'/product/'+p.id,img=p.image_url?(/^https?:/.test(p.image_url)?p.image_url:(process.env.BASE_URL||`${req.protocol}://${req.get('host')}`)+p.image_url):'',u=encodeURIComponent(url);
 res.send(page(req,p.name,`<p><a href="/">&larr; Back to products</a></p><div class="two"><img src="${esc(p.image_url||'/img/none.svg')}" alt="${esc(p.name)}" style="width:100%;border-radius:10px;aspect-ratio:1/1;object-fit:cover"><div>
<h1>${esc(p.name)}</h1><span class="tag">${esc(p.category||'General')}</span><div class="price" style="font-size:26px">${M(p.price)}</div><p>${stockTxt(p.stock)}${p.stock>0?` <span class="mut">(${p.stock} available)</span>`:''}</p><p style="white-space:pre-line">${esc(p.description)}</p>
<form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}"><label for="q">Quantity</label><div class="row"><input id="q" type="number" name="qty" value="1" min="1" max="${Math.max(1,p.stock)}" ${p.stock>0?'':'disabled'}><button class="acc" ${p.stock>0?'':'disabled'}>Add to Cart</button></div></form>
<h2>Share this product</h2><div class="row"><a class="btn fb" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${u}">Share on Facebook</a><a class="btn tg" target="_blank" rel="noopener" href="https://t.me/share/url?url=${u}&text=${encodeURIComponent(p.name)}">Share on Telegram</a></div></div></div>`,
 `<meta name="description" content="${esc((p.description||'').slice(0,150))}"><meta property="og:type" content="product"><meta property="og:title" content="${esc(p.name)}"><meta property="og:description" content="${esc((p.description||'').slice(0,150))}"><meta property="og:url" content="${esc(url)}">${img?`<meta property="og:image" content="${esc(img)}">`:''}<link rel="canonical" href="${esc(url)}">`))});

app.post('/cart/add',(req,res)=>{const p=db.prepare("SELECT * FROM products WHERE id=? AND status='active'").get(int(req.body.id));
 if(!p||p.stock<1)return res.redirect('/cart?msg='+encodeURIComponent('That product is not available'));
 const have=db.prepare('SELECT qty FROM carts WHERE cid=? AND product_id=?').get(req.ck,p.id)?.qty||0,qty=Math.min(p.stock,have+Math.max(1,int(req.body.qty,1)));
 db.prepare('INSERT INTO carts VALUES(?,?,?) ON CONFLICT(cid,product_id) DO UPDATE SET qty=excluded.qty').run(req.ck,p.id,qty);
 res.redirect('/cart?msg='+encodeURIComponent(qty<have+int(req.body.qty,1)?'Added. Only '+p.stock+' in stock.':'Added to cart'))});
app.post('/cart/update',(req,res)=>{const p=db.prepare('SELECT stock FROM products WHERE id=?').get(int(req.body.id)),q=int(req.body.qty);
 if(!p||q<1)db.prepare('DELETE FROM carts WHERE cid=? AND product_id=?').run(req.ck,int(req.body.id));else db.prepare('UPDATE carts SET qty=? WHERE cid=? AND product_id=?').run(Math.min(q,p.stock),req.ck,int(req.body.id));res.redirect('/cart?msg=Cart+updated')});
app.post('/cart/remove',(req,res)=>{db.prepare('DELETE FROM carts WHERE cid=? AND product_id=?').run(req.ck,int(req.body.id));res.redirect('/cart?msg=Item+removed')});
app.get('/cart',(req,res)=>{const it=cartItems(req.ck);
 res.send(page(req,'Cart',`<h1>Your cart</h1>`+(it.length?`<div class="tw"><table><tr><th>Product</th><th>Unit price</th><th>Quantity</th><th>Subtotal</th><th></th></tr>${it.map(i=>`<tr><td><a href="/product/${i.id}">${esc(i.name)}</a></td><td>${M(i.price)}</td>
<td><form method="post" action="/cart/update" class="row" style="margin:0"><input type="hidden" name="id" value="${i.id}"><input type="number" name="qty" value="${i.qty}" min="0" max="${i.stock}" aria-label="Quantity for ${esc(i.name)}"><button class="btn ghost" style="color:var(--ink)">Update</button></form></td><td>${M(i.price*i.qty)}</td>
<td><form method="post" action="/cart/remove" style="margin:0"><input type="hidden" name="id" value="${i.id}"><button class="del">Remove</button></form></td></tr>`).join('')}<tr><th colspan="3">Total</th><th colspan="2" class="price">${M(sum(it))}</th></tr></table></div>
<div class="row"><a class="btn ghost" href="/">Continue shopping</a><a class="btn acc" href="/checkout">Proceed to Checkout</a></div>`:`<p>Your cart is empty. <a href="/">Browse products</a>.</p>`)))});

/* ---------- KHQR payment (Bakong) ----------
   QR is generated here with the official NBC SDK (works offline). Payment is verified with the Bakong Open API (check_transaction_by_md5).
   Modes: no BAKONG_ACCOUNT_ID -> placeholder image | account only -> dynamic QR, shop confirms manually | account + token -> automatic check. */
const {BakongKHQR,khqrData,IndividualInfo}=require('bakong-khqr'),QRCode=require('qrcode');
const KH={acct:process.env.BAKONG_ACCOUNT_ID,token:process.env.BAKONG_TOKEN,api:(process.env.BAKONG_API_URL||'https://api-bakong.nbc.gov.kh').replace(/\/$/,''),cur:(process.env.KHQR_CURRENCY||'USD').toUpperCase(),rate:+process.env.KHR_RATE||4100,
 city:process.env.MERCHANT_CITY||'Phnom Penh',name:process.env.MERCHANT_NAME||SHOP,phone:process.env.KHQR_PHONE||''};
KH.verify=!!(KH.acct&&KH.token)&&process.env.KHQR_VERIFY!='off';
const khAmount=t=>KH.cur=='KHR'?Math.round(t*KH.rate):r2(t),khText=a=>KH.cur=='KHR'?Number(a).toLocaleString('en-US')+' KHR':'$'+Number(a).toFixed(2);
async function payInfo(cid,total){
 if(!KH.acct)return null;const now=Date.now();
 let p=db.prepare('SELECT * FROM payments WHERE cid=? AND total=? AND order_id IS NULL AND expires>? ORDER BY created DESC').get(cid,total,now+60000);
 if(!p){const ref=crypto.randomBytes(8).toString('hex'),amount=khAmount(total),expires=now+15*60*1000,
   opt={currency:KH.cur=='KHR'?khqrData.currency.khr:khqrData.currency.usd,amount,billNumber:('W'+ref).toUpperCase(),storeLabel:KH.name.slice(0,25),terminalLabel:'WEB',expirationTimestamp:expires};
  if(KH.phone)opt.mobileNumber=KH.phone;
  const r=new BakongKHQR().generateIndividual(new IndividualInfo(KH.acct,KH.name.slice(0,25),KH.city.slice(0,15),opt));
  if(r.status.code!==0)throw new Error('KHQR error '+r.status.errorCode+': '+r.status.message);
  db.prepare('INSERT INTO payments(ref,cid,total,amount,qr,md5,expires,created) VALUES(?,?,?,?,?,?,?,?)').run(ref,cid,total,amount,r.data.qr,r.data.md5,expires,now);
  p=db.prepare('SELECT * FROM payments WHERE ref=?').get(ref)}
 return{...p,img:await QRCode.toDataURL(p.qr,{margin:2,width:260,errorCorrectionLevel:'H'})}}
async function checkPaid(md5,amount){
 try{const r=await fetch(KH.api+'/v1/check_transaction_by_md5',{method:'POST',headers:{Authorization:'Bearer '+KH.token,'Content-Type':'application/json'},body:JSON.stringify({md5}),signal:AbortSignal.timeout(15000)});
  const j=await r.json().catch(()=>({}));
  if(r.status==401||r.status==403||j.errorCode==6)return{s:'ERROR',m:'The payment service refused our access (check BAKONG_TOKEN, or the server location).'};
  if(j.responseCode===0){const d=j.data||{};if(d.amount!=null&&Math.abs(Number(d.amount)-amount)>0.001)return{s:'UNPAID'};return{s:'PAID'}}
  return r.ok||r.status==404?{s:'UNPAID'}:{s:'ERROR',m:'The payment service had a problem ('+r.status+').'}}
 catch(e){return{s:'ERROR',m:'Cannot reach the payment service right now.'}}}

function checkoutPage(req,it,v={},errs=[],pay=null){const tot=sum(it);
 const amtText=pay?khText(pay.amount):M(tot),imgSrc=pay?pay.img:khqrImg(),
  cm=amtText.match(/^(.*)\s(KHR)$/),amtMain=cm?cm[1]:amtText,amtCur=cm?cm[2]:'',
  meta=pay?`<p class="mut">Scan with Bakong or any KHQR banking app. This QR code is valid until ${new Date(pay.expires).toLocaleTimeString('en-GB',{timeZone:process.env.SHOP_TZ||'Asia/Phnom_Penh',hour:'2-digit',minute:'2-digit'})}. ${KH.verify?'After paying, press the button below. Your payment is checked automatically.':'After paying, press the button below. The shop will confirm your payment.'}</p><input type="hidden" name="ref" value="${esc(pay.ref)}">`:`<p class="mut">Scan with Bakong or any KHQR banking app, then press the button below.</p>`,
  qr=`<div class="khqr-standee"><div class="khqr-head"><img class="khqr-logo-img" src="/img/khqr.svg" alt="KHQR"></div>
<div class="khqr-info"><div class="khqr-merchant">${esc(KH.name)}</div><div class="khqr-amount">${esc(amtMain)}${amtCur?` <span class="khqr-cur">${esc(amtCur)}</span>`:''}</div></div>
<div class="khqr-divider"></div>
<div class="khqr-qrwrap"><img src="${imgSrc}" alt="KHQR payment code" width="220" height="220">
<span class="khqr-qrlogo"><img src="/img/bakong.svg" alt="Bakong" width="34" height="34"></span></div>
</div>`;
 return page(req,'Checkout',`<h1>Checkout</h1>${errs.length?`<div class="err" role="alert"><b>Please check:</b><ul>${errs.map(e=>`<li>${esc(e)}</li>`).join('')}</ul></div>`:''}
<form method="post" action="/checkout" class="two"><div><h2>Your details</h2>
<label for="n">Full name</label><input id="n" name="name" required maxlength="100" autocomplete="name" value="${esc(v.name)}">
<label for="e">Email address</label><input id="e" type="email" name="email" required maxlength="120" autocomplete="email" value="${esc(v.email)}">
<label for="p">Phone number</label><input id="p" type="tel" name="phone" required maxlength="20" autocomplete="tel" value="${esc(v.phone)}">
<label for="a">Shipping address</label><textarea id="a" name="address" rows="3" required maxlength="300" autocomplete="street-address">${esc(v.address)}</textarea></div>
<div><h2>Order summary</h2><div class="card">${it.map(i=>`<div class="row" style="justify-content:space-between;margin:0 0 6px"><span>${esc(i.name)} &times; ${i.qty}</span><span>${M(i.price*i.qty)}</span></div>`).join('')}<div class="row price" style="justify-content:space-between"><span>Total</span><span>${M(tot)}</span></div></div>
<h2>Pay with KHQR</h2><div class="qr">${qr}${meta}<button class="acc" style="width:100%;margin-top:14px">I have paid &ndash; Place order</button></div></div></form>`)}
app.get('/checkout',async(req,res)=>{const it=cartItems(req.ck);if(!it.length)return res.redirect('/cart?msg=Your+cart+is+empty');
 const v=req.user?{name:req.user.name,email:req.user.email}:{};res.send(checkoutPage(req,it,v,[],await payInfo(req.cid,sum(it))))});
app.post('/checkout',async(req,res)=>{const it=cartItems(req.ck);if(!it.length)return res.redirect('/cart?msg=Your+cart+is+empty');
 const b=req.body,v={name:String(b.name||'').trim(),email:String(b.email||'').trim(),phone:String(b.phone||'').trim(),address:String(b.address||'').trim()},errs=[],total=sum(it);
 const fail=async(list,code=400)=>res.status(code).send(checkoutPage(req,cartItems(req.ck),v,list,await payInfo(req.cid,sum(cartItems(req.ck)))));
 if(v.name.length<2||v.name.length>100)errs.push('Enter your full name');if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)||v.email.length>120)errs.push('Enter a valid email address');
 if(!/^\+?[0-9 ()-]{6,20}$/.test(v.phone))errs.push('Enter a valid phone number');if(v.address.length<5||v.address.length>300)errs.push('Enter your shipping address');
 if(errs.length)return fail(errs);
 let pay=null,pstatus='Pending verification';
 if(KH.acct){pay=db.prepare('SELECT * FROM payments WHERE ref=? AND cid=?').get(String(b.ref||''),req.cid);
  if(!pay||pay.order_id||pay.total!==total)return fail(['Your cart or QR code changed. Please scan the new QR code below.']);
  if(KH.verify){const r=await checkPaid(pay.md5,pay.amount);
   if(r.s=='ERROR')return fail([r.m+' If you already paid, please try again in a moment or contact the shop.'],503);
   if(r.s=='UNPAID')return fail(['We have not received your payment yet. Please scan the QR code, complete the payment in your banking app, then press the button again.']);
   pstatus='Paid'}}
 try{const tk=db.transaction(()=>{const cur=cartItems(req.ck);if(!cur.length)throw new Error('Your cart is empty');
   for(const i of cur){const s=db.prepare('SELECT stock FROM products WHERE id=?').get(i.id).stock;if(i.qty>s)throw new Error(`${i.name}: only ${s} left in stock`)}
   const t=crypto.randomBytes(16).toString('hex'),id=db.prepare('INSERT INTO orders(token,customer_name,email,phone,address,total,payment_status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(t,v.name,v.email,v.phone,v.address,sum(cur),pstatus,new Date().toISOString()).lastInsertRowid;
   if(pay&&db.prepare('UPDATE payments SET order_id=? WHERE ref=? AND order_id IS NULL').run(id,pay.ref).changes!==1)throw new Error('This payment was already used for another order');
   for(const i of cur){db.prepare('INSERT INTO order_items(order_id,product_id,name,price,qty) VALUES(?,?,?,?,?)').run(id,i.id,i.name,i.price,i.qty);db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(i.qty,i.id)}
   db.prepare('DELETE FROM carts WHERE cid=?').run(req.ck);return t})();res.redirect('/order/confirmation/'+tk)}
 catch(e){await fail([e.message])}});
app.get('/order/confirmation/:token',(req,res)=>{const o=db.prepare('SELECT * FROM orders WHERE token=?').get(String(req.params.token));if(!o)return notFound(req,res);const it=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
 res.send(page(req,'Order confirmed',`<div class="success"><h1 style="margin:0">Thank you! Your order was placed successfully.</h1><p style="margin:6px 0 0">${o.payment_status=='Paid'?'Your KHQR payment was received. We will ship your order soon.':'We will confirm your KHQR payment and ship your order soon.'}</p></div>
<div class="two" style="margin-top:20px"><div class="card"><h2 style="margin-top:0">Order #${o.id}</h2><p><b>Name:</b> ${esc(o.customer_name)}<br><b>Email:</b> ${esc(o.email)}<br><b>Phone:</b> ${esc(o.phone)}<br><b>Shipping address:</b> ${esc(o.address)}<br><b>Date:</b> ${fmt(o.created_at)}<br><b>Payment:</b> KHQR (${esc(o.payment_status||'Pending verification')})</p></div>
<div class="card"><h2 style="margin-top:0">Items</h2>${it.map(i=>`<div class="row" style="justify-content:space-between;margin:0 0 6px"><span>${esc(i.name)} &times; ${i.qty}</span><span>${M(i.price*i.qty)}</span></div>`).join('')}<div class="row price" style="justify-content:space-between"><span>Total amount</span><span>${M(o.total)}</span></div></div></div><p><a class="btn" href="/">Continue shopping</a></p>`))});

app.get('/my-orders',(req,res)=>{if(!req.user)return res.redirect('/login?next=/my-orders');
 const l=db.prepare('SELECT * FROM orders WHERE email=? ORDER BY id DESC').all(req.user.email);
 res.send(page(req,'My orders',`<h1>My orders</h1><div class="tw"><table><tr><th>Order ID</th><th>Total</th><th>Payment</th><th>Order Date</th><th>Action</th></tr>${l.map(o=>`<tr><td>#${o.id}</td><td>${M(o.total)}</td><td>${esc(o.payment_status||'Pending verification')}</td><td>${fmt(o.created_at)}</td><td><a class="btn ghost" href="/my-orders/${o.id}">View Details</a></td></tr>`).join('')||'<tr><td colspan="5">No orders yet. <a href="/">Browse products</a>.</td></tr>'}</table></div>`))});
app.get('/my-orders/:id',(req,res)=>{if(!req.user)return res.redirect('/login?next=/my-orders');
 const o=db.prepare('SELECT * FROM orders WHERE id=? AND email=?').get(int(req.params.id),req.user.email);if(!o)return notFound(req,res);
 const it=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
 res.send(page(req,'Order #'+o.id,`<p><a href="/my-orders">&larr; Back to my orders</a></p><h1>Order #${o.id}</h1><div class="two"><div class="card"><h2 style="margin-top:0">Details</h2><p><b>Name:</b> ${esc(o.customer_name)}<br><b>Email:</b> ${esc(o.email)}<br><b>Phone:</b> ${esc(o.phone)}<br><b>Shipping address:</b> ${esc(o.address)}<br><b>Date:</b> ${fmt(o.created_at)}<br><b>Payment:</b> ${esc(o.payment)} (${esc(o.payment_status||'Pending verification')})</p></div>
<div class="card"><h2 style="margin-top:0">Items</h2>${it.map(i=>`<div class="row" style="justify-content:space-between;margin:0 0 6px"><span>${esc(i.name)} &times; ${i.qty}</span><span>${M(i.price*i.qty)}</span></div>`).join('')}<div class="row price" style="justify-content:space-between"><span>Total amount</span><span>${M(o.total)}</span></div></div></div>`))});

/* ---------- LOGIN / REGISTER (shared by customers and admin) ---------- */
const loginTries={};
const authPage=(req,title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | ${esc(SHOP)}</title><link rel="stylesheet" href="/style.css"></head><body>
<header><div class="wrap"><a class="brand" href="/">${esc(SHOP)}</a><nav><a href="/">Home</a><a href="/cart">Cart (${req.cartCount})</a></nav></div></header><main class="wrap" style="max-width:420px">${flash(req)}${body}</main></body></html>`;
const loginForm=(req,err='')=>authPage(req,'Log in',`<h1>Log in</h1>${err?`<p class="err" role="alert">${esc(err)}</p>`:''}
<form method="post" action="/login" class="card"><input type="hidden" name="next" value="${esc(req.query.next||'')}">
<label for="e" style="margin-top:0">Email</label><input id="e" type="email" name="email" required autocomplete="username">
<label for="pw">Password</label><input id="pw" type="password" name="password" required autocomplete="current-password">
<p><button class="acc" style="width:100%">Log in</button></p></form>
<p><a href="/register${req.query.next?'?next='+encodeURIComponent(req.query.next):''}">No account? Register</a></p>`);
const registerForm=(req,err='')=>authPage(req,'Create account',`<h1>Create account</h1>${err?`<p class="err" role="alert">${esc(err)}</p>`:''}
<form method="post" action="/register" class="card"><input type="hidden" name="next" value="${esc(req.query.next||'')}">
<label for="n" style="margin-top:0">Full name</label><input id="n" name="name" required maxlength="100" autocomplete="name">
<label for="e">Email</label><input id="e" type="email" name="email" required autocomplete="username">
<label for="pw">Password</label><input id="pw" type="password" name="password" required minlength="6" autocomplete="new-password">
<p><button class="acc" style="width:100%">Register</button></p></form>
<p><a href="/login${req.query.next?'?next='+encodeURIComponent(req.query.next):''}">Have an account? Log in</a></p>`);
app.get('/login',(req,res)=>res.send(loginForm(req)));
app.post('/login',(req,res)=>{const k=req.ip,t=loginTries[k]=(loginTries[k]||[]).filter(x=>Date.now()-x<9e5);if(t.length>=10)return res.status(429).send(loginForm(req,'Too many attempts. Try again in 15 minutes.'));
 const email=String(req.body.email||'').trim().toLowerCase(),u=db.prepare('SELECT * FROM users WHERE email=?').get(email);
 if(!u||!crypto.timingSafeEqual(Buffer.from(pwHash(req.body.password||'',u.salt)),Buffer.from(u.hash))){t.push(Date.now());return res.status(401).send(loginForm(req,'Wrong email or password'))}
 startSession(res,u.email);mergeGuestCart(req.cid,u.email);const next=String(req.body.next||'');
 res.redirect(u.role=='admin'?'/admin/dashboard':(next&&next.startsWith('/')?next:'/'))});
app.get('/register',(req,res)=>res.send(registerForm(req)));
app.post('/register',(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),name=String(req.body.name||'').trim(),pw=String(req.body.password||'');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).send(registerForm(req,'Enter a valid email address'));
 if(!name||name.length>100)return res.status(400).send(registerForm(req,'Enter your full name'));
 if(pw.length<6)return res.status(400).send(registerForm(req,'Use a password with 6 or more characters'));
 if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email))return res.status(409).send(registerForm(req,'That email already has an account'));
 const salt=crypto.randomBytes(16).toString('hex');
 db.prepare('INSERT INTO users(email,name,salt,hash,role) VALUES(?,?,?,?,?)').run(email,name,salt,pwHash(pw,salt),'customer');
 startSession(res,email);mergeGuestCart(req.cid,email);const next=String(req.body.next||'');res.redirect(next&&next.startsWith('/')?next:'/')});
app.post('/logout',(req,res)=>{const t=cookie(req,'sid');if(t)db.prepare('DELETE FROM sessions WHERE token=?').run(t);setCookie(res,'sid','','SameSite=Lax; Max-Age=0');res.redirect('/')});

/* ---------- ADMIN ---------- */
app.use('/admin',requireAdmin);
app.get('/admin',(req,res)=>res.redirect('/admin/dashboard'));
app.get('/admin/dashboard',(req,res)=>{
 const orders=db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
 const sales=r2(orders.reduce((a,o)=>a+o.total,0));
 const cost=r2(db.prepare('SELECT oi.qty,p.purchase_price FROM order_items oi JOIN products p ON p.id=oi.product_id').all().reduce((a,r)=>a+r.qty*r.purchase_price,0));
 const profit=r2(sales-cost);
 const customers=new Set(orders.map(o=>o.email)).size;
 const low=db.prepare("SELECT * FROM products WHERE status='active' AND stock<=5 ORDER BY stock").all();
 const pending=orders.filter(o=>o.payment_status!='Paid').slice(0,8);
 res.send(apage(req,'Dashboard',`<h1>Admin panel</h1>
<div class="grid"><div class="card"><div class="mut">Total selling (sales)</div><div class="price">${M(sales)}</div></div><div class="card"><div class="mut">Total purchasing (cost)</div><div class="price">${M(cost)}</div></div>
<div class="card"><div class="mut">Profit</div><div class="price">${M(profit)}</div></div><div class="card"><div class="mut">Orders</div><div class="price">${orders.length}</div></div>
<div class="card"><div class="mut">Customers</div><div class="price">${customers}</div></div><div class="card"><div class="mut">Low stock items</div><div class="price ${low.length?'bad':''}">${low.length}</div></div></div>
<h2>Orders to process</h2>${pending.length?`<div class="tw"><table><tr><th>Order ID</th><th>Customer</th><th>Total</th><th>Payment</th></tr>${pending.map(o=>`<tr><td><a href="/admin/orders/${o.id}">#${o.id}</a></td><td>${esc(o.customer_name)}</td><td>${M(o.total)}</td><td>${esc(o.payment_status||'Pending verification')}</td></tr>`).join('')}</table></div>`:'<p class="mut">Nothing waiting.</p>'}
<h2>Low stock</h2>${low.length?`<div class="tw"><table><tr><th>Product</th><th>Stock</th></tr>${low.map(p=>`<tr><td><a href="/admin/products/${p.id}/edit">${esc(p.name)}</a></td><td class="bad">${p.stock}</td></tr>`).join('')}</table></div>`:'<p class="mut">All stocked up.</p>'}`))});

app.get('/admin/products',(req,res)=>{const l=db.prepare('SELECT * FROM products ORDER BY id').all();
 res.send(apage(req,'Products',`<div class="row" style="justify-content:space-between;margin:0 0 12px"><h1 style="margin:0">Products</h1><a class="btn acc" href="/admin/products/new">+ Add New Product</a></div><div class="tw"><table><tr><th>ID</th><th>Name</th><th>Category</th><th>Purchase</th><th>Price</th><th>Margin</th><th>Stock</th><th>Status</th><th>Actions</th></tr>${l.map(p=>{const margin=p.price>0?Math.round((1-p.purchase_price/p.price)*100):0;return`<tr><td>${p.id}</td><td><div class="row" style="margin:0;flex-wrap:nowrap"><img class="thumb" src="${esc(p.image_url||'/img/none.svg')}" alt=""><span>${esc(p.name)}</span></div></td><td><span class="tag">${esc(p.category||'General')}</span></td><td>${M(p.purchase_price)}</td><td>${M(p.price)}</td><td>${margin}%</td><td class="${p.stock<=5?'bad':''}">${p.stock}</td><td><span class="tag">${p.status=='active'?'Active':'Inactive'}</span></td>
<td><div class="row" style="margin:0"><a class="btn ghost" href="/admin/products/${p.id}/edit">Edit</a><form method="post" action="/admin/products/${p.id}/delete" style="margin:0" onsubmit="return confirm('Delete ${esc(p.name).replace(/'/g,'')}?')"><button class="del">Delete</button></form></div></td></tr>`}).join('')||'<tr><td colspan="9">No products yet.</td></tr>'}</table></div>`))});
const pform=(req,p,action,title,errs=[])=>apage(req,title,`<h1>${title}</h1>${errs.length?`<div class="err" role="alert"><ul>${errs.map(e=>`<li>${esc(e)}</li>`).join('')}</ul></div>`:''}<form method="post" action="${action}" class="card" style="max-width:640px">
<label for="n" style="margin-top:0">Name</label><input id="n" name="name" required maxlength="120" value="${esc(p.name)}"><label for="d">Description</label><textarea id="d" name="description" rows="5" maxlength="2000">${esc(p.description)}</textarea>
<label for="c">Category</label><input id="c" name="category" maxlength="40" placeholder="e.g. Electronics" value="${esc(p.category||'')}">
<label for="pp">Purchase price ($)</label><input id="pp" type="number" name="purchase_price" step="0.01" min="0" value="${esc(p.purchase_price??0)}" style="width:100%">
<label for="pr">Price ($)</label><input id="pr" type="number" name="price" step="0.01" min="0" required value="${esc(p.price)}" style="width:100%"><label for="s">Stock quantity</label><input id="s" type="number" name="stock" min="0" step="1" required value="${esc(p.stock)}" style="width:100%">
<label for="i">Image URL</label><input id="i" name="image_url" placeholder="https://... or /img/laptop.webp" value="${esc(p.image_url)}"><label for="st">Status</label><select id="st" name="status"><option value="active" ${p.status!='inactive'?'selected':''}>Active (visible in shop)</option><option value="inactive" ${p.status=='inactive'?'selected':''}>Inactive (hidden)</option></select>
<div class="row"><button class="acc">Save</button><a class="btn ghost" href="/admin/products">Cancel</a></div></form>`);
function readProd(b){const p={name:String(b.name||'').trim(),description:String(b.description||'').trim(),category:String(b.category||'').trim()||'General',price:Number(b.price),purchase_price:Number(b.purchase_price||0),stock:Number(b.stock),image_url:String(b.image_url||'').trim(),status:b.status=='inactive'?'inactive':'active'},e=[];
 if(!p.name||p.name.length>120)e.push('Name is required (max 120 characters)');if(p.description.length>2000)e.push('Description is too long');if(p.category.length>40)e.push('Category is too long');
 if(!(p.price>=0)||p.price>1e6)e.push('Price must be 0 or more');if(!(p.purchase_price>=0)||p.purchase_price>1e6)e.push('Purchase price must be 0 or more');if(!Number.isInteger(p.stock)||p.stock<0)e.push('Stock must be a whole number, 0 or more');
 if(p.image_url&&!/^(https?:\/\/|\/)/i.test(p.image_url))e.push('Image URL must start with http://, https:// or /');return{p,e}}
app.get('/admin/products/new',(req,res)=>res.send(pform(req,{status:'active',stock:0,category:'General',purchase_price:0},'/admin/products','Add New Product')));
app.post('/admin/products',(req,res)=>{const{p,e}=readProd(req.body);if(e.length)return res.status(400).send(pform(req,p,'/admin/products','Add New Product',e));
 db.prepare('INSERT INTO products(name,description,price,stock,image_url,status,category,purchase_price) VALUES(?,?,?,?,?,?,?,?)').run(p.name,p.description,p.price,p.stock,p.image_url,p.status,p.category,p.purchase_price);res.redirect('/admin/products?msg=Product+added')});
app.get('/admin/products/:id/edit',(req,res)=>{const p=db.prepare('SELECT * FROM products WHERE id=?').get(int(req.params.id));if(!p)return notFound(req,res);res.send(pform(req,p,'/admin/products/'+p.id,'Edit Product #'+p.id))});
app.post('/admin/products/:id/delete',(req,res)=>{const id=int(req.params.id);db.prepare('DELETE FROM products WHERE id=?').run(id);db.prepare('DELETE FROM carts WHERE product_id=?').run(id);res.redirect('/admin/products?msg=Product+deleted')});
app.post('/admin/products/:id',(req,res)=>{const id=int(req.params.id);if(!db.prepare('SELECT 1 FROM products WHERE id=?').get(id))return notFound(req,res);const{p,e}=readProd(req.body);p.id=id;
 if(e.length)return res.status(400).send(pform(req,p,'/admin/products/'+id,'Edit Product #'+id,e));
 db.prepare('UPDATE products SET name=?,description=?,price=?,stock=?,image_url=?,status=?,category=?,purchase_price=? WHERE id=?').run(p.name,p.description,p.price,p.stock,p.image_url,p.status,p.category,p.purchase_price,id);res.redirect('/admin/products?msg=Product+saved')});
app.get('/admin/orders',(req,res)=>{const l=db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
 res.send(apage(req,'Order history',`<h1>Order history</h1><div class="tw"><table><tr><th>Order ID</th><th>Customer Name</th><th>Phone Number</th><th>Total Amount</th><th>Order Date</th><th>Action</th></tr>${l.map(o=>`<tr><td>#${o.id}</td><td>${esc(o.customer_name)}</td><td>${esc(o.phone)}</td><td>${M(o.total)}</td><td>${fmt(o.created_at)}</td><td><a class="btn ghost" href="/admin/orders/${o.id}">View Order Details</a></td></tr>`).join('')||'<tr><td colspan="6">No orders yet.</td></tr>'}</table></div>`))});
app.get('/admin/orders/:id',(req,res)=>{const o=db.prepare('SELECT * FROM orders WHERE id=?').get(int(req.params.id));if(!o)return notFound(req,res);const it=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
 res.send(apage(req,'Order #'+o.id,`<p><a href="/admin/orders">&larr; Back to order history</a></p><h1>Order #${o.id}</h1><div class="two"><div class="card"><h2 style="margin-top:0">Customer</h2><p><b>Name:</b> ${esc(o.customer_name)}<br><b>Email:</b> ${esc(o.email)}<br><b>Phone:</b> ${esc(o.phone)}<br><b>Shipping address:</b> ${esc(o.address)}<br><b>Date:</b> ${fmt(o.created_at)}<br><b>Payment:</b> ${esc(o.payment)} (${esc(o.payment_status||'Pending verification')})</p></div>
<div class="card"><h2 style="margin-top:0">Purchased items</h2><div class="tw"><table><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Subtotal</th></tr>${it.map(i=>`<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${M(i.price)}</td><td>${M(i.price*i.qty)}</td></tr>`).join('')}<tr><th colspan="3">Total</th><th>${M(o.total)}</th></tr></table></div></div></div>`))});

function notFound(req,res){res.status(404).send(page(req,'Not found','<h1>Page not found</h1><p><a href="/">Back to the shop</a></p>'))}
app.use((req,res)=>notFound(req,res));
app.use((err,req,res,next)=>{console.error(err);res.status(500).send(page(req,'Error','<h1>Something went wrong</h1><p><a href="/">Back to the shop</a></p>'))});
app.listen(PORT,()=>console.log(`${SHOP} running on port ${PORT}`));
