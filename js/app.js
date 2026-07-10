/* ================================================================
   BARBERS BLOCK
   4 livelli: Admin (1) · Proprietario (2) · Barbiere (3) · Cliente (4)
================================================================ */
const DOW=['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
const MON=['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
const MF=['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const $=id=>document.getElementById(id);
const initials=n=>{n=(n||'?').trim();const p=n.split(/\s+/);return(((p[0]||'')[0]||'')+((p[1]||'')[0]||'')).toUpperCase()||'?';};
// Every field a CUSTOMER or anonymous visitor controls (booking name/phone,
// review author/comment) ends up interpolated into an .innerHTML template
// somewhere in the owner/barber dashboard or another customer's page — this
// is the one place that closes that off. Always wrap user-entered text with
// this before putting it in an HTML template string; never rely on the
// field having been "checked" elsewhere (length checks are not escaping).
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dayLabel=iso=>{const d=new Date(iso+'T00:00:00');return`${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;};
const isoOf=(y,m,d)=>`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
const todayISO=()=>{
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const localDate = new Date(d.getTime() - (offset * 60 * 1000));
  return localDate.toISOString().split('T')[0];
};
function relDay(iso){
  if(!iso)return'—';
  const t=new Date();t.setHours(0,0,0,0);
  const d=new Date(iso+'T00:00:00');
  const diff=Math.round((t-d)/86400000);
  if(diff<=0)return'Oggi';if(diff===1)return'Ieri';
  if(diff<7)return diff+' giorni fa';if(diff<14)return'1 settimana fa';
  if(diff<30)return Math.floor(diff/7)+' settimane fa';if(diff<60)return'1 mese fa';
  return Math.floor(diff/30)+' mesi fa';
}
const isOnVacation=(w,iso)=>!!(w.vacFrom&&w.vacTo&&iso>=w.vacFrom&&iso<=w.vacTo);
// Riposo settimanale: giorni della settimana (0=Dom … 6=Sab, come getDay())
// in cui il barbiere non lavora, indipendente per ogni barbiere.
const OFFDAY_DEFS=[[1,'Lun'],[2,'Mar'],[3,'Mer'],[4,'Gio'],[5,'Ven'],[6,'Sab'],[0,'Dom']];
const isWeeklyOff=(w,iso)=>Array.isArray(w.offDays)&&w.offDays.includes(new Date(iso+'T00:00:00').getDay());
// Etichetta compatta dei giorni di riposo, es. "Lun" o "Lun, Dom".
const offDaysLabel=w=>(Array.isArray(w.offDays)?OFFDAY_DEFS.filter(([v])=>w.offDays.includes(v)).map(([,l])=>l):[]).join(', ');
const freqTag=m=>m>=2?{l:'Fedele',c:'f-fedele'}:m>=1?{l:'Regolare',c:'f-regolare'}:{l:'Da riattivare',c:'f-occ'};

// Downscales an image client-side (max 1200px, JPEG) before uploading —
// phone photos are 3-10MB, far beyond what the KV image storage accepts,
// and a hero/avatar never needs more than ~1200px anyway.
function readFileAsDataURL(file){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onerror=()=>reject(new Error('Impossibile leggere il file'));
    r.onload=()=>resolve(r.result);
    r.readAsDataURL(file);
  });
}
async function compressImage(file){
  const dataUrl=await readFileAsDataURL(file);
  try{
    const img=await new Promise((resolve,reject)=>{
      const i=new Image();
      i.onload=()=>resolve(i);
      i.onerror=()=>reject(new Error('decode'));
      i.src=dataUrl;
    });
    const MAX=1200;
    let w=img.naturalWidth,h=img.naturalHeight;
    if(!w||!h)throw new Error('decode');
    if(w>MAX||h>MAX){const k=Math.min(MAX/w,MAX/h);w=Math.round(w*k);h=Math.round(h*k);}
    const canvas=document.createElement('canvas');
    canvas.width=w;canvas.height=h;
    canvas.getContext('2d').drawImage(img,0,0,w,h);
    const out=canvas.toDataURL('image/jpeg',0.82);
    if(out.length<dataUrl.length){
      return{dataUrl:out,contentType:'image/jpeg',filename:(file.name||'foto').replace(/\.\w+$/,'')+'.jpg'};
    }
  }catch(e){/* formato non decodificabile — carica l'originale */}
  return{dataUrl,contentType:file.type,filename:file.name||'foto'};
}

// Reads a File, compresses it and uploads it to /api/upload-image (Vercel
// Blob or KV fallback), returning the public URL. Used by the salon photo
// pickers (principale + galleria) and the worker photo picker.
async function uploadImageFile(file){
  if(!file)throw new Error('Nessun file selezionato');
  if(!file.type.startsWith('image/'))throw new Error('Seleziona un file immagine');
  const{dataUrl,contentType,filename}=await compressImage(file);
  const dataBase64=dataUrl.split(',')[1];
  const resp=await fetch('/api/upload-image',{
    method:'POST',
    headers:{'Content-Type':'application/json', ...authHeaders()},
    body:JSON.stringify({filename,dataBase64,contentType})
  });
  const data=await resp.json().catch(()=>({}));
  if(!resp.ok)throw new Error(data.error||data.message||'Upload fallito');
  return data.url;
}

// Wires a file-input + text-input(URL) + preview-img + status-label group so
// picking a file uploads it and fills the URL field automatically. Shared by
// the salon "Foto Principale" and worker "Foto del Barbiere" pickers.
function wireImagePicker(fileInputId,urlInputId,previewId,statusId){
  const fileInput=$(fileInputId);
  if(!fileInput)return;
  fileInput.addEventListener('change',async()=>{
    const file=fileInput.files&&fileInput.files[0];
    if(!file)return;
    const status=$(statusId);
    if(status)status.textContent='Caricamento in corso...';
    try{
      const url=await uploadImageFile(file);
      $(urlInputId).value=url;
      const preview=$(previewId);
      if(preview){preview.src=url;preview.style.display='block';}
      if(status)status.textContent='✓ Immagine caricata';
    }catch(e){
      if(status)status.textContent='Errore: '+e.message;
    }finally{
      fileInput.value='';
    }
  });
}

// Curated per-salon accent palette: each hex chosen to stay readable as text
// on the app's dark cards/hero (bright/mid-tone, not a true "dark" shade,
// which would lose contrast on black) — replaces the default gold (--gold)
// scoped to #vCustomer only, so the admin dashboard keeps its own gold.
const SALON_THEME_PALETTE=[
  {name:'Oro',hex:'#e5c158',rgb:'229,193,88'},
  {name:'Smeraldo',hex:'#10b981',rgb:'16,185,129'},
  {name:'Zaffiro',hex:'#3b82f6',rgb:'59,130,246'},
  {name:'Bordeaux',hex:'#ef4444',rgb:'239,68,68'},
  {name:'Ametista',hex:'#a78bfa',rgb:'167,139,250'},
  {name:'Rame',hex:'#d97706',rgb:'217,119,6'},
  {name:'Turchese',hex:'#2dd4bf',rgb:'45,212,191'},
  {name:'Argento',hex:'#94a3b8',rgb:'148,163,184'}
];
const DEFAULT_SLOTS=['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30','19:00','19:30','20:00','20:30','21:00'];
const DEFAULT_SERVICES=[
  {id:'sv0',name:'Taglio',dur:'30 min',price:15},
  {id:'sv1',name:'Barba',dur:'20 min',price:12},
  {id:'sv2',name:'Taglio + Barba',dur:'45 min',price:25},
  {id:'sv3',name:'Shampoo + Taglio',dur:'40 min',price:20}
];

/* ======== STATE ======== */
let STATE={
  admin:{username:'admin',password:'admin123',homepagePhotos:[]},
  homepageAd: {
    title: 'Trimio Pro Care',
    description: 'Usa il codice TRIMIO15 sul nostro store per ricevere il 15% di sconto su cera, lozioni e balsamo per capelli e barba!',
    btnText: 'Copia Codice',
    code: 'TRIMIO15'
  },
  salons:[{
    id:'salon1',name:'Barber Art',slug:'BARBER_ART',city:'Bergamo',
    address:'Via Sentierone 12',
    phone:'+39 035 123 4567',
    promo: 'Mostra questo banner in salone per ricevere uno shampoo omaggio!',
    closedDays:[],bookingDays:30,
    services:DEFAULT_SERVICES.map(s=>({...s})),
    ownerUsername:'owner',ownerPassword:'owner123',
    workers:[
      {
        id:'w1',name:'Shqipe',username:'shqipe',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Specialista in colorazione dei capelli, cura della barba e tagli di capelli per bambini.',
        img: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Alessandro M.', comment: 'Taglio fantastico, molto attenta ai dettagli. Consigliatissima!', date: '2026-06-15'},
          {rating: 4, author: 'Sofia R.', comment: 'Servizio molto buono e puntuale.', date: '2026-06-20'}
        ]
      },
      {
        id:'w2',name:'Klajdi',username:'klajdi',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Maestro Barbiere',
        desc: 'Il re delle linee di precisione, della modellatura della barba e dei servizi combinati.',
        img: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Matteo B.', comment: 'Klajdi è un professionista eccezionale, il mio barbiere di fiducia.', date: '2026-06-10'},
          {rating: 5, author: 'Giuseppe V.', comment: 'Sfocatura perfetta. Atmosfera amichevole.', date: '2026-06-25'}
        ]
      },
      {
        id:'w3',name:'Mario',username:'mario',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Maestro dei tagli sfumati moderni e rasatura classica a lama libera.',
        img: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Lorenzo G.', comment: 'Mario sa sempre come consigliarti. Molto soddisfatto.', date: '2026-06-18'},
          {rating: 4, author: 'Federico L.', comment: 'Taglio barba veloce e preciso.', date: '2026-06-22'}
        ]
      },
      {
        id:'w4',name:'Francesco',username:'francesco',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Esperto in modellatura barba scolpita e look classici maschili.',
        img: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Davide P.', comment: 'Simpatico e molto bravo con le forbici.', date: '2026-06-12'},
          {rating: 5, author: 'Marco T.', comment: 'Esperienza eccellente, ci tornerò sicuramente.', date: '2026-06-26'}
        ]
      },
      {
        id:'w5',name:'Kristian',username:'kristian',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Specialista in sfumature estreme e acconciature artistiche.',
        img: 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Pietro S.', comment: 'Ottimo servizio, molto pulito e cordiale.', date: '2026-06-14'}
        ]
      }
    ]
  },
  {
    id:'salon2',name:'Trimio Milano',slug:'TRIMIO_MILANO',city:'Milano',
    address:'Via Monte Napoleone 8',
    phone:'+39 02 987 6543',
    promo: '10% di sconto sul primo taglio prenotato online!',
    closedDays:[],bookingDays:30,
    services:DEFAULT_SERVICES.map(s=>({...s})),
    ownerUsername:'owner_milano',ownerPassword:'owner123',
    workers:[
      {
        id:'w_mil_1',name:'Luca',username:'luca',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Specialista in colorazione dei capelli, cura della barba e tagli di capelli per bambini.',
        img: 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Andrea P.', comment: 'Servizio eccellente, Luca è bravissimo e veloce.', date: '2026-06-20'},
          {rating: 4, author: 'Filippo M.', comment: 'Ottimo taglio di capelli, locale molto pulito.', date: '2026-06-22'}
        ]
      },
      {
        id:'w_mil_2',name:'Marco',username:'marco',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Maestro Barbiere',
        desc: 'Il re delle linee di precisione, della modellatura della barba e dei servizi combinati.',
        img: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Roberto L.', comment: 'Marco ha una cura per i dettagli pazzesca.', date: '2026-06-18'}
        ]
      },
      {
        id:'w_mil_3',name:'Andrea',username:'andrea',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Maestro dei tagli sfumati moderni e della cura maschile classica.',
        img: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Stefano T.', comment: 'Sempre cordiale ed estremamente professionale.', date: '2026-06-19'}
        ]
      },
      {
        id:'w_mil_4',name:'Matteo',username:'matteo',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Esperto in rasatura tradizionale con panno caldo e modellatura barba.',
        img: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Davide G.', comment: 'Consigliatissimo per la barba, un vero maestro.', date: '2026-06-24'}
        ]
      }
    ]
  },
  {
    id:'salon3',name:'Trimio Roma',slug:'TRIMIO_ROMA',city:'Roma',
    address:'Via del Corso 45',
    phone:'+39 06 123 4567',
    promo: 'Prenota oggi e ricevi una lozione dopo-rasatura in omaggio!',
    closedDays:[],bookingDays:30,
    services:DEFAULT_SERVICES.map(s=>({...s})),
    ownerUsername:'owner_roma',ownerPassword:'owner123',
    workers:[
      {
        id:'w_rom_1',name:'Giuseppe',username:'giuseppe',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Maestro Barbiere',
        desc: 'Il re delle linee di precisione, della modellatura della barba e dei servizi combinati.',
        img: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Claudio R.', comment: 'Il miglior barbiere di Roma, senza dubbio.', date: '2026-06-14'}
        ]
      },
      {
        id:'w_rom_2',name:'Francesco',username:'francesco_r',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Specialista in colorazione dei capelli, cura della barba e tagli di capelli per bambini.',
        img: 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Daniele F.', comment: 'Taglio perfetto e piega eccezionale.', date: '2026-06-21'}
        ]
      },
      {
        id:'w_rom_3',name:'Roberto',username:'roberto',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Creatore di look contemporanei, specializzato in sfumature ad alta precisione.',
        img: 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 4, author: 'Simone B.', comment: 'Molto bravo e professionale, consigliato.', date: '2026-06-23'}
        ]
      },
      {
        id:'w_rom_4',name:'Antonio',username:'antonio',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Esperto di stile classico italiano e trattamenti rivitalizzanti per capelli.',
        img: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Emanuele V.', comment: 'Precisione geometrica nel taglio. Grande Antonio!', date: '2026-06-25'}
        ]
      }
    ]
  },
  {
    id:'salon4',name:'Trimio Firenze',slug:'TRIMIO_FIRENZE',city:'Firenze',
    address:'Piazza della Signoria 5',
    phone:'+39 055 765 4321',
    promo: 'Shampoo purificante gratuito con ogni taglio + barba!',
    closedDays:[],bookingDays:30,
    services:DEFAULT_SERVICES.map(s=>({...s})),
    ownerUsername:'owner_firenze',ownerPassword:'owner123',
    workers:[
      {
        id:'w_fir_1',name:'Lorenzo',username:'lorenzo',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Maestro Barbiere',
        desc: 'Il re delle linee di precisione, della modellatura della barba e dei servizi combinati.',
        img: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Gabriele N.', comment: 'Lorenzo è bravissimo ed il salone è stupendo.', date: '2026-06-16'}
        ]
      },
      {
        id:'w_fir_2',name:'Giovanni',username:'giovanni',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Specialista in colorazione dei capelli, cura della barba e tagli di capelli per bambini.',
        img: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Alessio C.', comment: 'Sfumatura perfetta, cura del cliente al top.', date: '2026-06-19'}
        ]
      },
      {
        id:'w_fir_3',name:'Filippo',username:'filippo',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto di tagli moderni texturizzati e rasature tradizionali.',
        img: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 4, author: 'Mattia D.', comment: 'Molto simpatico e competente.', date: '2026-06-22'}
        ]
      },
      {
        id:'w_fir_4',name:'Simone',username:'simone',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Maestro nella cura della barba e acconciature su misura.',
        img: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&h=150&fit=crop&crop=face',
        reviews: [
          {rating: 5, author: 'Christian S.', comment: 'Taglio barba rilassante e preciso. Ottimo.', date: '2026-06-26'}
        ]
      }
    ]
  },
  {
    id:'salon5',name:'Trimio Napoli',slug:'TRIMIO_NAPOLI',city:'Napoli',
    address:'Via Toledo 156',
    phone:'+39 081 234 5678',
    promo: 'Mostra questo banner per una piega stile napoletano gratuita!',
    closedDays:[],bookingDays:30,
    services:DEFAULT_SERVICES.map(s=>({...s})),
    ownerUsername:'owner_napoli',ownerPassword:'owner123',
    workers:[
      {
        id:'w_nap_1',name:'Vincenzo',username:'vincenzo',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Maestro Barbiere',
        desc: 'Il re delle linee di precisione, della modellatura della barba e dei servizi combinati.',
        img: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Luca S.', comment: 'Vincenzo è bravissimo, sfumature perfette.', date: '2026-06-20'}]
      },
      {
        id:'w_nap_2',name:'Gennaro',username:'gennaro',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Specialista in colorazione dei capelli, cura della barba e tagli di capelli per bambini.',
        img: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Marco T.', comment: 'Ottimo servizio, molto attento ai dettagli.', date: '2026-06-21'}]
      },
      {
        id:'w_nap_3',name:'Pasquale',username:'pasquale',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Maestro dei tagli sfumati moderni e della cura maschile classica.',
        img: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 4, author: 'Ciro A.', comment: 'Taglio pulito, barbiere molto simpatico.', date: '2026-06-22'}]
      },
      {
        id:'w_nap_4',name:'Salvatore',username:'salvatore',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto in rasatura tradizionale con panno caldo e modellatura barba.',
        img: 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Peppe F.', comment: 'Servizio barba eccellente, rilassante.', date: '2026-06-24'}]
      },
      {
        id:'w_nap_5',name:'Ciro',username:'ciro',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Creatore di look contemporanei, specializzato in sfumature ad alta precisione.',
        img: 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Fabio V.', comment: 'Ciro sa sempre consigliarti lo stile adatto.', date: '2026-06-25'}]
      },
      {
        id:'w_nap_6',name:'Diego',username:'diego',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto di stile classico italiano e trattamenti rivitalizzanti per capelli.',
        img: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Raffaele M.', comment: 'Panno caldo e barba fantastici. Consigliatissimo.', date: '2026-06-26'}]
      }
    ]
  },
  {
    id:'salon6',name:'Trimio Torino',slug:'TRIMIO_TORINO',city:'Torino',
    address:'Via Roma 88',
    phone:'+39 011 345 6789',
    promo: 'Mostra questo banner per riceve un massaggio cutaneo gratuito!',
    closedDays:[],bookingDays:30,
    services:DEFAULT_SERVICES.map(s=>({...s})),
    ownerUsername:'owner_torino',ownerPassword:'owner123',
    workers:[
      {
        id:'w_tor_1',name:'Alessandro',username:'alessandro',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Maestro Barbiere',
        desc: 'Il re delle linee di precisione, della modellatura della barba e dei servizi combinati.',
        img: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Alberto B.', comment: 'Il top a Torino, linee pulitissime.', date: '2026-06-19'}]
      },
      {
        id:'w_tor_2',name:'Davide',username:'davide',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Specialista in colorazione dei capelli, cura della barba e tagli di capelli per bambini.',
        img: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Claudio Z.', comment: 'Molto bravo con i bambini, paziente e preciso.', date: '2026-06-20'}]
      },
      {
        id:'w_tor_3',name:'Federico',username:'federico',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Maestro dei tagli sfumati moderni e della cura maschile classica.',
        img: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 4, author: 'Piero G.', comment: 'Ottima cura del cliente e ambiente rilassante.', date: '2026-06-22'}]
      },
      {
        id:'w_tor_4',name:'Giorgio',username:'giorgio',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto in rasatura tradizionale con panno caldo e modellatura barba.',
        img: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Michele R.', comment: 'La rasatura panno caldo è fantastica.', date: '2026-06-23'}]
      },
      {
        id:'w_tor_5',name:'Stefano',username:'stefano',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Creatore di look contemporanei, specializzato in sfumature ad alta precisione.',
        img: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Giacomo F.', comment: 'Sempre soddisfatto del servizio di Stefano.', date: '2026-06-24'}]
      },
      {
        id:'w_tor_6',name:'Alberto',username:'alberto',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto di stile classico italiano e trattamenti rivitalizzanti per capelli.',
        img: 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Lorenzo P.', comment: 'Davvero professionale, ottimi prodotti.', date: '2026-06-25'}]
      }
    ]
  },
  {
    id:'salon7',name:'Trimio Venezia',slug:'TRIMIO_VENEZIA',city:'Venezia',
    address:'Piazza San Marco 12',
    phone:'+39 041 456 7890',
    promo: '15% di sconto sul primo servizio per residenti!',
    closedDays:[],bookingDays:30,
    services:DEFAULT_SERVICES.map(s=>({...s})),
    ownerUsername:'owner_venezia',ownerPassword:'owner123',
    workers:[
      {
        id:'w_ven_1',name:'Marco',username:'marco_v',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Maestro Barbiere',
        desc: 'Il re delle linee di precisione, della modellatura della barba e dei servizi combinati.',
        img: 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Daniele K.', comment: 'Puntualità e precisione al massimo livello.', date: '2026-06-18'}]
      },
      {
        id:'w_ven_2',name:'Fabio',username:'fabio',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Specialista in colorazione dei capelli, cura della barba e tagli di capelli per bambini.',
        img: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Filippo O.', comment: 'Ottimo taglio e lozione fantastica.', date: '2026-06-20'}]
      },
      {
        id:'w_ven_3',name:'Paolo',username:'paolo',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Maestro dei tagli sfumati moderni e della cura maschile classica.',
        img: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 4, author: 'Andrea L.', comment: 'Locale stupendo e servizio rapido.', date: '2026-06-22'}]
      },
      {
        id:'w_ven_4',name:'Pietro',username:'pietro_v',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto in rasatura tradizionale con panno caldo e modellatura barba.',
        img: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Max T.', comment: 'Il trattamento barba di Pietro è eccezionale.', date: '2026-06-23'}]
      },
      {
        id:'w_ven_5',name:'Matteo',username:'matteo_v',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Creatore di look contemporanei, specializzato in sfumature ad alta precisione.',
        img: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Christian D.', comment: 'Taglio moderno impeccabile, consigliato.', date: '2026-06-25'}]
      },
      {
        id:'w_ven_6',name:'Giovanni',username:'giovanni_v',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto di stile classico italiano e trattamenti rivitalizzanti per capelli.',
        img: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Stefano M.', comment: 'Molto professionale, consigliatissimo.', date: '2026-06-26'}]
      }
    ]
  },
  {
    id:'salon8',name:'Trimio Bologna',slug:'TRIMIO_BOLOGNA',city:'Bologna',
    address:'Via dell\'Indipendenza 22',
    phone:'+39 051 567 8901',
    promo: 'Fai un taglio + barba e ricevi uno spray fissante omaggio!',
    closedDays:[],bookingDays:30,
    services:DEFAULT_SERVICES.map(s=>({...s})),
    ownerUsername:'owner_bologna',ownerPassword:'owner123',
    workers:[
      {
        id:'w_bol_1',name:'Filippo',username:'filippo_b',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Maestro Barbiere',
        desc: 'Il re delle linee di precisione, della modellatura della barba e dei servizi combinati.',
        img: 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Renato F.', comment: 'Grandissima tecnica con le forbici.', date: '2026-06-18'}]
      },
      {
        id:'w_bol_2',name:'Andrea',username:'andrea_b',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Specialista in colorazione dei capelli, cura della barba e tagli di capelli per bambini.',
        img: 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Sofia U.', comment: 'Mio figlio adora farsi tagliare i capelli da Andrea.', date: '2026-06-20'}]
      },
      {
        id:'w_bol_3',name:'Nicola',username:'nicola',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Maestro dei tagli sfumati moderni e della cura maschile classica.',
        img: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 4, author: 'Giorgio T.', comment: 'Ottimo taglio e servizio impeccabile.', date: '2026-06-22'}]
      },
      {
        id:'w_bol_4',name:'Riccardo',username:'riccardo',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto in rasatura tradizionale con panno caldo e modellatura barba.',
        img: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Domenico A.', comment: 'Panno caldo eccezionale, un vero relax.', date: '2026-06-24'}]
      },
      {
        id:'w_bol_5',name:'Christian',username:'christian',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Creatore di look contemporanei, specializzato in sfumature ad alta precisione.',
        img: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Federico M.', comment: 'Christian è bravissimo, sfocatura favolosa.', date: '2026-06-25'}]
      },
      {
        id:'w_bol_6',name:'Tommaso',username:'tommaso',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto di stile classico italiano e trattamenti rivitalizzanti per capelli.',
        img: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Enzo G.', comment: 'Prodotti di qualità e servizio super.', date: '2026-06-26'}]
      }
    ]
  },
  {
    id:'salon9',name:'Trimio Palermo',slug:'TRIMIO_PALERMO',city:'Palermo',
    address:'Via della Libertà 95',
    phone:'+39 091 678 9012',
    promo: 'Usa il codice PALERMO10 sul sito per prenotare a prezzo ridotto!',
    closedDays:[],bookingDays:30,
    services:DEFAULT_SERVICES.map(s=>({...s})),
    ownerUsername:'owner_palermo',ownerPassword:'owner123',
    workers:[
      {
        id:'w_pal_1',name:'Antonio',username:'antonio_p',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Maestro Barbiere',
        desc: 'Il re delle linee di precisione, della modellatura della barba e dei servizi combinati.',
        img: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Rosario I.', comment: 'Sempre cordiale, taglio perfetto.', date: '2026-06-18'}]
      },
      {
        id:'w_pal_2',name:'Salvatore',username:'salvatore_p',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Specialista in colorazione dei capelli, cura della barba e tagli di capelli per bambini.',
        img: 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Carmelo G.', comment: 'Il mio barbiere preferito a Palermo.', date: '2026-06-20'}]
      },
      {
        id:'w_pal_3',name:'Giuseppe',username:'giuseppe_p',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Maestro dei tagli sfumati moderni e della cura maschile classica.',
        img: 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 4, author: 'Dario P.', comment: 'Precisione impeccabile con macchinetta.', date: '2026-06-22'}]
      },
      {
        id:'w_pal_4',name:'Francesco',username:'francesco_p',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto in rasatura tradizionale con panno caldo e modellatura barba.',
        img: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Vincenzo B.', comment: 'Panno caldo spettacolare e mani d\'oro.', date: '2026-06-24'}]
      },
      {
        id:'w_pal_5',name:'Roberto',username:'roberto_p',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere e Parrucchiere',
        desc: 'Creatore di look contemporanei, specializzato in sfumature ad alta precisione.',
        img: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Sergio T.', comment: 'Molto bravo, sfumature curatissime.', date: '2026-06-25'}]
      },
      {
        id:'w_pal_6',name:'Calogero',username:'calogero',password:'barber123',vacFrom:'',vacTo:'',
        role: 'Barbiere Esperto',
        desc: 'Esperto di stile classico italiano e trattamenti rivitalizzanti per capelli.',
        img: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
        reviews: [{rating: 5, author: 'Luca E.', comment: 'Ottima esperienza, consigliatissimo.', date: '2026-06-26'}]
      }
    ]
  }],
  bookings:[]
};
const SK='bb3_state';
const canStore=typeof window!=='undefined';
const DEFAULT_SALONS_BACKUP = JSON.parse(JSON.stringify(STATE.salons));

let firebaseEnabled = false;
const firebaseConfig = {
  apiKey: "PLACEHOLDER_API_KEY",
  authDomain: "PLACEHOLDER_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://PLACEHOLDER_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId: "PLACEHOLDER_PROJECT_ID",
  storageBucket: "PLACEHOLDER_PROJECT_ID.appspot.com",
  messagingSenderId: "PLACEHOLDER_SENDER_ID",
  appId: "PLACEHOLDER_APP_ID"
};

async function loadState(){
  if(!canStore)return;
  try{
    let val = null;
    if (window.storage && typeof window.storage.get === 'function') {
      const r = await window.storage.get(SK, true);
      val = r?.value;
    } else {
      val = localStorage.getItem(SK);
    }
    if(val){
      const s=JSON.parse(val);
      if(s?.salons && s.salons.length > 0){
        if(s.bookings) s.bookings = s.bookings.filter(b => !b.isDemo);
        STATE=s;
      } else {
        // Safe fallback if local storage salons were wiped
        STATE.salons = JSON.parse(JSON.stringify(DEFAULT_SALONS_BACKUP));
      }
    }
  }catch(e){}
}

let isSaving = false;
// Settles when the first /api/sync fetch completes (ok or not) — boot's
// routing awaits it before deciding a salon slug is unknown, because a
// fresh install has no local copy of the cloud salons yet.
let initialCloudSync = null;

// Attaches the signed session token (issued at login, see doLogin) to
// /api/sync and /api/subscribe requests so the server can tell an admin/
// owner/barber apart from an anonymous visitor and scope PII accordingly —
// without the client ever holding a plaintext password locally again.
function authHeaders(){
  return (typeof SESSION !== 'undefined' && SESSION && SESSION.token)
    ? { 'Authorization': 'Bearer ' + SESSION.token }
    : {};
}

async function saveState(){
  isSaving = true;
  const cleanBookings = (STATE.bookings || []).filter(b => !b.isDemo);
  const stateCopy = { ...STATE, bookings: cleanBookings };

  if(canStore){
    try{
      if (window.storage && typeof window.storage.set === 'function') {
        await window.storage.set(SK, JSON.stringify(stateCopy), true);
      } else {
        localStorage.setItem(SK, JSON.stringify(stateCopy));
      }
    }catch(e){
      console.error("localStorage save failed:", e);
    }
  }

  // Upload to Vercel Cloud Blob for cross-device sync
  try {
    const syncResp = await fetch('/api/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders()
      },
      body: JSON.stringify({
        bookings: cleanBookings,
        salons: STATE.salons,
        admin: { username: STATE.admin.username }
      })
    });
    if (syncResp.ok) {
      const resData = await syncResp.json().catch(() => null);
      if (resData && resData.bookings) {
        const prevDemoBks = (STATE.bookings || []).filter(b => b.isDemo);
        STATE.bookings = [...prevDemoBks, ...resData.bookings];
        if (canStore) {
          try {
            localStorage.setItem(SK, JSON.stringify(STATE));
          } catch(e) {}
        }
      }
      return { ok: true, conflicts: (resData && resData.conflicts) || [] };
    } else {
      const errText = await syncResp.text().catch(() => 'unknown');
      console.error("Cloud sync POST failed:", syncResp.status, errText);
      return { ok: false, conflicts: [] };
    }
  } catch (e) {
    console.error("Cloud sync save error:", e);
    return { ok: false, conflicts: [] };
  } finally {
    // Keep lock active for 2.5 seconds to let server cache propagate
    setTimeout(() => {
      isSaving = false;
    }, 2500);
  }
}

function initCloudSync() {
  const updateUIStatus = (isConnected) => {
    const dot = $('adminSyncStatusDot');
    const title = $('adminSyncStatusTitle');
    const desc = $('adminSyncStatusDesc');
    const badge = $('syncStatusBadge');
    
    if (isConnected) {
      if (dot) dot.style.backgroundColor = '#10b981';
      if (title) title.textContent = 'Sincronizzazione Attiva (Vercel Cloud)';
      if (desc) desc.textContent = 'Il database cloud è connesso in tempo reale. I dati di prenotazione e recensioni sono sincronizzati su ogni cellulare e browser.';
      if (badge) {
        badge.querySelector('.dot-indicator').style.backgroundColor = '#10b981';
        badge.querySelector('.status-lbl').textContent = 'Sync Cloud';
        badge.style.color = '#10b981';
      }
    } else {
      if (dot) dot.style.backgroundColor = '#ef4444';
      if (title) title.textContent = 'Sync Offline (Local Storage)';
      if (desc) desc.textContent = 'I dati sono salvati localmente su questo dispositivo.';
      if (badge) {
        badge.querySelector('.dot-indicator').style.backgroundColor = '#ef4444';
        badge.querySelector('.status-lbl').textContent = 'Sync Offline';
        badge.style.color = '#ef4444';
      }
    }
  };

  updateUIStatus(true);

  // Initial load from Vercel Cloud Blob with cache-busting to bypass browser cache
  initialCloudSync = fetch('/api/sync?t=' + Date.now(), { cache: 'no-store', headers: authHeaders() })
    .then(r => {
      if (!r.ok) {
        updateUIStatus(false);
        throw new Error(`HTTP ${r.status}`);
      }
      updateUIStatus(true);
      return r.json();
    })
    .then(data => {
      if (data) {
        // Safeguard: Only update salons if the cloud database contains them.
        // If the cloud is brand new and empty, upload our local salons to initialize it.
        if (data.salons && data.salons.length > 0) {
          STATE.salons = data.salons;
        } else if (STATE.salons && STATE.salons.length > 0) {
          saveState(); // Upload local salons to seed the cloud database
        }

        // Admin username: adopt whatever the server has (so a username
        // change made from any device is picked up everywhere). The password
        // is never shipped by the server at all anymore — login and password
        // changes go through /api/sync's action-based branches (lib/auth.js),
        // which read/write it directly in KV.
        if (data.admin && typeof data.admin.username === 'string' && data.admin.username) {
          STATE.admin.username = data.admin.username;
        }
        if (data.admin && Array.isArray(data.admin.homepagePhotos)) {
          STATE.admin.homepagePhotos = data.admin.homepagePhotos;
        }

        if (data.bookings) {
          const fbBookings = Array.isArray(data.bookings) ? data.bookings : Object.values(data.bookings);
          const prevBookings = STATE.bookings || [];
          const localNonDemoBookings = prevBookings.filter(b => !b.isDemo && !fbBookings.some(cb => cb.id === b.id));
          const localDemoBookings = prevBookings.filter(b => b.isDemo);
          
          STATE.bookings = [...localDemoBookings, ...localNonDemoBookings, ...fbBookings];
          
          if (localNonDemoBookings.length > 0) {
            console.log("Syncing offline bookings to Vercel KV:", localNonDemoBookings);
            saveState();
          } else {
            // Save to local storage
            localStorage.setItem(SK, JSON.stringify({ ...STATE, bookings: fbBookings }));
          }
        }
        
        // Refresh UI
        if (typeof renderDash === 'function' && curSec) renderDash();
        if (typeof renderHomepage === 'function' && !custSalon) renderHomepage();
        if (typeof renderVLoginSalonShowcase === 'function') renderVLoginSalonShowcase();
        if (typeof renderVLoginPhotoGallery === 'function') renderVLoginPhotoGallery();
        // Kick out customer if salon became inactive
        if (custSalon) {
          const refreshed = STATE.salons.find(s => s.id === custSalon.id);
          if (refreshed) {
            if (refreshed.inactive) {
              alert(`Spiacenti, il salone "${refreshed.name}" è temporaneamente inattivo. Contatta l'amministratore.`);
              custSalon = null;
              location.hash = '';
              renderHomepage();
              showView('vHome');
            } else {
              custSalon = refreshed;
              if (typeof applyCustomerTheme === 'function') applyCustomerTheme(refreshed);
              // The hero (background photo + gallery carousel) is rendered once
              // from whatever salon snapshot was available at initCustomer() time
              // — usually a stale/default copy, since this cloud fetch is still
              // in flight then. Re-render it now that the real bgImage/gallery
              // (uploaded via KV) have arrived, or a salon's photos never show
              // to customers who load the page fresh.
              if (typeof initCustHero === 'function') initCustHero(refreshed);
              if (custStep === 0 && typeof renderBarberGrid === 'function') renderBarberGrid();
              if (custStep === 1 && typeof renderCustServices === 'function') renderCustServices();
              if (custStep === 2 && typeof renderCustTimes === 'function') renderCustTimes();
              // This initial fetch is what actually populates STATE.bookings
              // with server data — re-run the banner now that it has real
              // bookings to look up (initCustomer() ran earlier with none yet).
              if (typeof renderCustMyBookingBanner === 'function') renderCustMyBookingBanner();
              if (typeof updateNavMenu === 'function') updateNavMenu();
            }
          }
        }

        // Kick out logged-in owner/barber if salon became inactive
        if (SESSION && SESSION.salonId) {
          const s = STATE.salons.find(x => x.id === SESSION.salonId);
          if (s && s.inactive) {
            alert(`Questo salone è stato disattivato dall'amministratore. Accesso negato.`);
            doLogout();
          }
        }
      }
    })
    .catch(e => {
      console.error("Initial sync fetch failed:", e);
      updateUIStatus(false);
    });

  // Polling every 6 seconds to sync status changes and new bookings.
  // Temporary compromise until upgrading to the Vercel/Upstash Pro plan
  // (was briefly 30s to protect the free KV quota, but felt too slow for
  // staff catching new bookings) — revisit once on Pro.
  setInterval(async () => {
    if (isSaving) return; // Skip polling updates while we are actively saving to prevent overwrites
    try {
      const response = await fetch('/api/sync?t=' + Date.now(), { cache: 'no-store', headers: authHeaders() });
      if (response.ok) {
        updateUIStatus(true);
        const data = await response.json();
        if (data) {
          const fbBookings = data.bookings ? (Array.isArray(data.bookings) ? data.bookings : Object.values(data.bookings)) : [];
          const prevBookings = STATE.bookings || [];
          const localDemoBookings = prevBookings.filter(b => b.isDemo);
          const mergedBookings = [...localDemoBookings, ...fbBookings];

          // Detect new bookings
          const newBks = fbBookings.filter(mb => !prevBookings.some(sb => sb.id === mb.id));
          newBks.forEach(newBk => triggerNewBookingNotification(newBk));

          // Detect status changes
          const statusChanged = fbBookings.some(mb => {
            const prev = prevBookings.find(sb => sb.id === mb.id);
            return prev && prev.status !== mb.status;
          });

          STATE.bookings = mergedBookings;
          
          // Safeguard: Only update salons if the response contains a non-empty list
          if (data.salons && data.salons.length > 0) {
            STATE.salons = data.salons;
          }

          if (data.admin && typeof data.admin.username === 'string' && data.admin.username) {
            STATE.admin.username = data.admin.username;
          }
          if (data.admin && Array.isArray(data.admin.homepagePhotos)) {
            STATE.admin.homepagePhotos = data.admin.homepagePhotos;
          }

          localStorage.setItem(SK, JSON.stringify({ ...STATE, bookings: fbBookings }));

          // Kick out customer if salon became inactive
          if (custSalon) {
            const refreshed = STATE.salons.find(s => s.id === custSalon.id);
            if (refreshed && refreshed.inactive) {
              alert(`Spiacenti, il salone "${refreshed.name}" è temporaneamente inattivo. Contatta l'amministratore.`);
              custSalon = null;
              location.hash = '';
              renderHomepage();
              showView('vHome');
            } else if (refreshed) {
              // Only rebuild the hero carousel if the photo set actually changed
              // — this poll runs every 4s, and re-initing unconditionally would
              // reset the carousel back to photo 0 constantly.
              const heroChanged = JSON.stringify([custSalon.bgImage, custSalon.gallery])
                !== JSON.stringify([refreshed.bgImage, refreshed.gallery]);
              custSalon = refreshed;
              if (typeof applyCustomerTheme === 'function') applyCustomerTheme(refreshed);
              if (heroChanged && typeof initCustHero === 'function') initCustHero(refreshed);
              // Keeps the "you have a booking" banner/modal in sync with
              // server-side status changes (e.g. the salon cancelling it)
              // without the customer having to do anything.
              if (typeof renderCustMyBookingBanner === 'function') renderCustMyBookingBanner();
              if (typeof renderMyBookingsModal === 'function' && $('myBookingsModal')?.classList.contains('show')) renderMyBookingsModal();
              if (typeof updateNavMenu === 'function') updateNavMenu();
            }
          }

          // Kick out logged-in owner/barber if salon became inactive
          if (SESSION && SESSION.salonId) {
            const s = STATE.salons.find(x => x.id === SESSION.salonId);
            if (s && s.inactive) {
              alert(`Questo salone è stato disattivato dall'amministratore. Accesso negato.`);
              doLogout();
            }
          }

          if (newBks.length > 0 || statusChanged) {
            if (typeof renderDash === 'function' && curSec) renderDash();
            if (statusChanged && typeof renderNewBookingsPanel === 'function') renderNewBookingsPanel();
          }
        }
      } else {
        updateUIStatus(false);
      }
    } catch (e) {
      console.error("Polling sync error:", e);
      updateUIStatus(false);
    }
  }, 6000);
}

/* ======== SINC ALERTS & NOTIFICHE APPLICAZIONE ======== */

function triggerNewBookingNotification(bk) {
  // Only notify if logged in as Owner of this salon, or Barber who is booked
  const isOwnerNotify = SESSION.role === 'owner' && SESSION.salonId === bk.salonId;
  const isBarberNotify = SESSION.role === 'barber' && SESSION.workerId === bk.workerId;
  
  if (!isOwnerNotify && !isBarberNotify) return;
  
  // 1. Play premium audio chime tone
  playNotificationSound();
  
  // 2. Show Toast banner
  showToastNotification(`📅 Nuova Prenotazione!<br><b>${escapeHtml(bk.name)}</b> per ${escapeHtml(bk.service)}<br>il ${relDay(bk.dateISO)} alle ${bk.time}`);
  
  // 3. System notification if allowed
  if (Notification.permission === 'granted') {
    new Notification("Nuova Prenotazione TRIMIO", {
      body: `${bk.name} - ${bk.service} alle ${bk.time} (${relDay(bk.dateISO)})`,
      icon: "./logo.png"
    });
  }

  // 4. Refresh new-bookings inbox panel
  renderNewBookingsPanel();
}

function playNotificationSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    
    const playTone = (freq, startTime, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      
      gain.gain.setValueAtTime(0.3, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };
    
    playTone(659.25, ctx.currentTime, 0.3); // E5
    playTone(880.00, ctx.currentTime + 0.15, 0.4); // A5
  } catch (e) {
    console.log("Audio play failed:", e);
  }
}

// Convert URL-safe base64 string to Uint8Array for VAPID subscription
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push notifications not supported on this browser.');
    return;
  }

  try {
    // 1. Register Service Worker
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registered successfully:', registration.scope);

    // 2. NEVER request permission here. This runs on page load / session
    // restore (no user gesture), and Safari/iOS auto-DENIES any permission
    // request made outside a real click — which then made every banner show
    // "Notifiche bloccate dal browser" even though the user was never asked.
    // Permission is requested only from explicit click handlers (login
    // button, "Attiva" banner buttons); here we just re-sync an existing
    // grant.
    if (Notification.permission !== 'granted') {
      console.warn('Notification permission not granted yet — skipping (ask via a button click).');
      return;
    }

    // 3. Subscribe to Push Manager
    const publicVapidKey = 'BLLKr1SroPRHybfSN2OunQUzy6yd5hggq2fmAmT90LL32Pgyaa_VkoESjUq3DGk0bgD2a5tb17bSZHc2heLJXGo';
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
    });

    console.log('Push subscription created:', subscription);

    // 4. Send subscription to server if user is logged in
    await syncPushSubscriptionToServer(subscription);

    // 5. The dashboard banner is often rendered before this subscribe() call
    // resolves (both run concurrently on session restore), so it initially
    // shows "inactive"/"Attiva" — refresh it now so it flips to "active"
    // on its own instead of leaving a stale prompt the owner/barber feels
    // they have to click every time they open the app.
    if (typeof renderPushNotifBanner === 'function') renderPushNotifBanner();

  } catch (err) {
    console.error('Failed to initialize push notifications:', err);
  }
}

// Read-only status check (never registers/subscribes) used to render the
// owner dashboard's push-notification banner.
async function getPushNotifStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'inactive';
  try {
    const registration = await navigator.serviceWorker.getRegistration('/sw.js');
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    return subscription ? 'active' : 'inactive';
  } catch (e) {
    return 'inactive';
  }
}

async function renderPushNotifBanner() {
  const banner = $('pushNotifBanner');
  if (!banner) return;
  if (!SESSION || (SESSION.role !== 'owner' && SESSION.role !== 'barber')) { banner.style.display = 'none'; return; }

  const status = await getPushNotifStatus();
  const icon = $('pushNotifIcon'), msg = $('pushNotifMsg'), btn = $('pushNotifBtn');

  if (status === 'unsupported') {
    // Same iOS rule as the customer banner: push exists only for web apps
    // installed on the Home Screen — guide staff there instead of hiding.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS && window.navigator.standalone !== true) {
      banner.style.display = 'flex';
      icon.textContent = '📲';
      msg.textContent = 'Per ricevere le notifiche delle prenotazioni: aggiungi TRIMIO alla schermata Home (Condividi → Aggiungi alla schermata Home) e accedi da lì.';
      btn.style.display = 'none';
      return;
    }
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'flex';
  if (status === 'active') {
    icon.textContent = '🔔';
    msg.textContent = 'Notifiche push attive per le nuove prenotazioni';
    btn.style.display = 'none';
  } else if (status === 'blocked') {
    icon.textContent = '⚠️';
    msg.textContent = 'Notifiche bloccate — su iPhone: Impostazioni → Notifiche → TRIMIO; su altri browser: impostazioni del sito';
    btn.style.display = 'none';
  } else {
    icon.textContent = '🔕';
    msg.textContent = 'Attiva le notifiche push per le nuove prenotazioni';
    btn.style.display = 'inline-block';
  }
}

async function syncPushSubscriptionToServer(subscription) {
  if (!SESSION || !SESSION.role) return;

  // role/salonId/workerId are no longer trusted from this payload server-side
  // — the server derives them from the signed token in the Authorization
  // header instead (see api/subscribe.js). Sent here too only so the
  // endpoint can 400 fast on a malformed request before checking the token.
  const payload = {
    subscription,
    role: SESSION.role
  };

  try {
    const resp = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload)
    });
    if (resp.ok) {
      console.log('Push subscription synced to server successfully.');
    } else {
      console.error('Failed to sync push subscription to server.');
    }
  } catch (err) {
    console.error('Error syncing push subscription to server:', err);
  }
}

// Customer-side reminder opt-in (24h-before push), separate from the staff
// (owner/barber/admin) flow above since a customer has no SESSION.role — the
// subscription is tied to this specific bookingId instead, and is what
// api/send-reminders.js (daily cron) looks up the day before the appointment.
async function initCustomerPushNotifications(bookingId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (Notification.permission !== 'granted') return false;
    const publicVapidKey = 'BLLKr1SroPRHybfSN2OunQUzy6yd5hggq2fmAmT90LL32Pgyaa_VkoESjUq3DGk0bgD2a5tb17bSZHc2heLJXGo';
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
      });
    }
    const resp = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, role: 'customer', bookingId })
    });
    return resp.ok;
  } catch (err) {
    console.error('Failed to init customer push notifications:', err);
    return false;
  }
}

function renderCustReminderBanner(alreadyActive) {
  const banner = $('custReminderBanner');
  if (!banner) return;
  const icon0 = $('custReminderIcon'), msg0 = $('custReminderMsg'), btn0 = $('custReminderBtn');
  // Reminder already re-armed silently for this booking (permission was
  // granted on a previous booking) — confirm instead of asking again.
  if (alreadyActive) {
    banner.style.display = 'flex';
    icon0.textContent = '✅';
    msg0.textContent = 'Promemoria attivo: riceverai una notifica prima di questo appuntamento.';
    btn0.style.display = 'none';
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // iOS Safari exposes PushManager ONLY inside web apps installed on the
    // Home Screen (iOS 16.4+). Instead of hiding the reminder option (which
    // made it look like it didn't exist), tell the customer how to enable it.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS && window.navigator.standalone !== true) {
      banner.style.display = 'flex';
      icon0.textContent = '📲';
      msg0.textContent = 'Per ricevere il promemoria 24h prima sulle prossime prenotazioni: aggiungi TRIMIO alla schermata Home (Condividi → Aggiungi alla schermata Home) e prenota da lì la prossima volta.';
      btn0.style.display = 'none';
    } else {
      banner.style.display = 'none';
    }
    return;
  }
  banner.style.display = 'flex';
  const icon = $('custReminderIcon'), msg = $('custReminderMsg'), btn = $('custReminderBtn');
  if (Notification.permission === 'denied') {
    icon.textContent = '⚠️';
    msg.textContent = 'Notifiche bloccate — su iPhone: Impostazioni → Notifiche → TRIMIO; su altri browser: impostazioni del sito';
    btn.style.display = 'none';
  } else {
    icon.textContent = '🔔';
    msg.textContent = "Vuoi ricevere un promemoria prima dell'appuntamento?";
    btn.style.display = 'inline-block';
    btn.textContent = 'Attiva';
    btn.disabled = false;
  }
}

function showToastNotification(message) {
  const container = $('toastContainer');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.style.background = 'rgba(24, 24, 27, 0.95)';
  toast.style.color = '#fff';
  toast.style.border = '1px solid #e5c158';
  toast.style.borderRadius = '16px';
  toast.style.padding = '14px 18px';
  toast.style.fontSize = '13.5px';
  toast.style.fontFamily = 'inherit';
  toast.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
  toast.style.backdropFilter = 'blur(8px)';
  toast.style.pointerEvents = 'auto';
  toast.style.display = 'flex';
  toast.style.alignItems = 'center';
  toast.style.gap = '10px';
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(-20px)';
  toast.style.transition = 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
  
  toast.innerHTML = `
    <div style="font-size: 20px;">🔔</div>
    <div style="flex:1;">${message}</div>
    <div style="cursor:pointer; opacity:0.6; font-size:16px;" onclick="this.parentElement.remove()">×</div>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  }, 50);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px)';
    setTimeout(() => { toast.remove(); }, 300);
  }, 6000);
}

/* ======== GEOLOCALIZZAZIONE & MAPPA ======== */
const CITY_COORDS = {
  'bergamo': { lat: 45.6983, lng: 9.6773 },
  'milano': { lat: 45.4642, lng: 9.1900 },
  'roma': { lat: 41.9028, lng: 12.4964 },
  'firenze': { lat: 43.7696, lng: 11.2558 },
  'napoli': { lat: 40.8518, lng: 14.2681 },
  'torino': { lat: 45.0703, lng: 7.6869 },
  'venezia': { lat: 45.4408, lng: 12.3155 },
  'bologna': { lat: 44.4949, lng: 11.3426 },
  'palermo': { lat: 38.1157, lng: 13.3615 }
};

let userCoords = null;
let map = null;
let markersGroup = null;

function setupSalonCoordinates() {
  if (!STATE || !STATE.salons) return;
  STATE.salons.forEach(s => {
    const cityKey = (s.city || '').toLowerCase().trim();
    if (CITY_COORDS[cityKey]) {
      s.lat = CITY_COORDS[cityKey].lat;
      s.lng = CITY_COORDS[cityKey].lng;
    }
  });
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

function findNearestSalons() {
  setupSalonCoordinates();
  
  if (!navigator.geolocation) {
    console.log("Geolocation not supported by this browser.");
    initMap();
    return;
  }
  
  navigator.geolocation.getCurrentPosition(
    (position) => {
      userCoords = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };
      
      // Calculate distance for all salons
      STATE.salons.forEach(s => {
        if (s.lat && s.lng) {
          s.distance = getDistance(userCoords.lat, userCoords.lng, s.lat, s.lng);
        }
      });
      
      // Sort salons by distance
      STATE.salons.sort((a, b) => {
        if (a.distance === undefined) return 1;
        if (b.distance === undefined) return -1;
        return a.distance - b.distance;
      });
      
      console.log("Salons sorted by distance:", STATE.salons);
      
      // Re-render salons list
      renderHomepage();
      
      // Initialize or update map
      initMap();
    },
    (error) => {
      console.log("Geolocation permission error/fallback:", error);
      initMap();
    },
    { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
  );
}

function initMap() {
  if (typeof L === 'undefined') return;
  
  const mapEl = $('map');
  if (!mapEl) return;
  
  // If map is already initialized, just update markers or return
  if (map) {
    renderMapMarkers();
    return;
  }
  
  // Default center of Italy (Roma area)
  map = L.map('map').setView([41.9028, 12.4964], 6);
  
  // Use a premium light Voyager tile layer to make the map bright and clear!
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);
  
  markersGroup = L.layerGroup().addTo(map);
  renderMapMarkers();
}

function renderMapMarkers() {
  if (!markersGroup || !map) return;
  markersGroup.clearLayers();
  
  // Add user marker if geolocation is available
  if (userCoords) {
    const userIcon = L.divIcon({
      className: 'user-marker-icon',
      html: `<div style="width: 14px; height: 14px; background: #3b82f6; border: 3px solid #fff; border-radius: 50%; box-shadow: 0 0 8px #3b82f6;"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
    L.marker([userCoords.lat, userCoords.lng], { icon: userIcon })
      .addTo(markersGroup)
      .bindPopup("<b>La tua posizione</b>")
      .openPopup();
  }
  
  // Add salon markers
  STATE.salons.forEach(s => {
    if (!s.lat || !s.lng) return;
    
    // Custom premium golden pin icon for salons!
    const salonIcon = L.divIcon({
      className: 'salon-marker-icon',
      html: `<div style="width: 22px; height: 22px; background: #e5c158; border: 2px solid #000; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; color: #000; box-shadow: 0 0 6px rgba(229,193,88,0.6);">✂️</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
    
    const distanceText = s.distance ? `<div style="font-size:11px; color:#e5c158; margin-top:2px;">📏 ${s.distance.toFixed(1)} km da te</div>` : '';
    
    const popupContent = `
      <div style="font-family: 'Inter', sans-serif; color: #fff; padding: 4px; min-width: 160px;">
        <b style="font-size:13px; color:#e5c158;">${s.name}</b>
        <div style="font-size:11px; margin-top:3px; color:#ccc;">📍 ${s.address || s.city}</div>
        ${distanceText}
        <div style="margin-top:8px; display:flex; gap:6px;">
          <a href="#${s.slug}" style="background:#e5c158; color:#000; padding:4px 8px; border-radius:4px; font-size:10px; font-weight:700; text-decoration:none; display:inline-block;">Prenota</a>
          <a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}" target="_blank" style="background:#333; color:#fff; padding:4px 8px; border-radius:4px; font-size:10px; font-weight:700; text-decoration:none; display:inline-block;">Indicazioni 🗺️</a>
        </div>
      </div>
    `;
    
    L.marker([s.lat, s.lng], { icon: salonIcon })
      .addTo(markersGroup)
      .bindPopup(popupContent);
  });
  
  // Adjust map view to show all salon markers (zoomed to fit just the areas
  // where salons actually are, not the whole country) — works whether or not
  // the user granted geolocation, since salon locations are known either way.
  const salonPoints = STATE.salons.filter(s => s.lat && s.lng).map(s => [s.lat, s.lng]);
  if (salonPoints.length) {
    const points = userCoords ? [[userCoords.lat, userCoords.lng], ...salonPoints] : salonPoints;
    if (points.length === 1) {
      map.setView(points[0], 13);
    } else {
      map.fitBounds(L.latLngBounds(points), { padding: [30, 30] });
    }
  }
}

/* ======== SESSION ======== */
// role: 'admin'|'owner'|'barber'
let SESSION={role:null,salonId:null,workerId:null,name:null};
const SESSION_KEY = 'bb3_session';

function saveSession() {
  if (canStore) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    } catch(e) {}
  }
}

function loadSession() {
  if (canStore) {
    try {
      const val = localStorage.getItem(SESSION_KEY);
      if (val) {
        SESSION = JSON.parse(val);
      }
    } catch(e) {}
  }
}

/* ======== HELPERS ======== */
function getSalon(){return STATE.salons.find(s=>s.id===SESSION.salonId)||null;}
function getSalonById(id){return STATE.salons.find(s=>s.id===id)||null;}
function bookedTimesFor(salonId,iso,workerId){
  return STATE.bookings.filter(b=>b.salonId===salonId&&b.dateISO===iso&&b.workerId===workerId&&b.status!=='cancelled').map(b=>b.time);
}

/* ======== DURATION-AWARE SCHEDULING ========
   Ogni prenotazione occupa [inizio, inizio+durata servizio): un servizio da
   40 min alle 10:00 libera il barbiere alle 10:40, uno da 20 min alle 10:20.
   Gli orari proposti sono "impacchettati" per ogni barbiere in modo
   indipendente: si parte dall'apertura e ci si sposta di una durata alla
   volta, saltando alla fine di ogni prenotazione già presa. */
function timeToMin(t){const m=/^(\d{1,2}):(\d{2})/.exec(t||'');return m?(+m[1])*60+(+m[2]):null;}
function minToTime(m){return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');}
function serviceDurMin(salon,serviceName){
  const svcs=(salon&&salon.services)||DEFAULT_SERVICES;
  const s=svcs.find(x=>x.name===serviceName);
  const n=s?parseInt(s.dur,10):NaN;
  return Number.isFinite(n)&&n>0?n:30;
}
// Mirrors bookingDurMin in api/sync.js: a booking snapshots its own duration
// at creation time now, so editing/renaming a service later can't silently
// shrink the busy-interval shown for appointments already on the books.
// Falls back to a live service-name lookup only for older bookings that
// predate this field.
function bookingDurMin(booking,salon){
  const own=parseInt(booking.dur,10);
  return Number.isFinite(own)&&own>0?own:serviceDurMin(salon,booking.service);
}
// End time of a booking given its salon/service/start — shown alongside the
// start time so the client/barber/owner see at a glance when the service
// actually finishes, not just when it starts.
function bookingEndTime(salon,serviceName,startTime){
  const startMin=timeToMin(startTime);
  if(startMin===null)return null;
  return minToTime(startMin+serviceDurMin(salon,serviceName));
}
function busyIntervalsFor(salonId,iso,workerId){
  const salon=getSalonById(salonId);
  const out=STATE.bookings
    .filter(b=>b.salonId===salonId&&b.dateISO===iso&&b.workerId===workerId&&b.status!=='cancelled')
    .map(b=>{const s=timeToMin(b.time);return s===null?null:{start:s,end:s+bookingDurMin(b,salon)};})
    .filter(Boolean);
  // Pausa pranzo personale del barbiere: vale ogni giorno lavorativo e blocca
  // gli slot che la attraversano, come una prenotazione fissa. Separata dal
  // buco pranzo del salone (griglia timeSlots), che invece vale per tutti.
  const worker=salon&&(salon.workers||[]).find(x=>x.id===workerId);
  if(worker&&worker.breakFrom&&worker.breakTo){
    const bs=timeToMin(worker.breakFrom),be=timeToMin(worker.breakTo);
    if(bs!==null&&be!==null&&be>bs)out.push({start:bs,end:be});
  }
  return out.sort((a,b)=>a.start-b.start);
}
// Unisce intervalli busy che si sovrappongono o si toccano, in ordine.
function mergeIntervals(busy){
  const sorted=[...busy].sort((a,b)=>a.start-b.start);
  const out=[];
  for(const b of sorted){
    const last=out[out.length-1];
    if(last&&b.start<=last.end)last.end=Math.max(last.end,b.end);
    else out.push({...b});
  }
  return out;
}
// Fasce orarie di INIZIO valide (in minuti) per un servizio da durMin,
// calcolate sottraendo durMin dal bordo destro di ogni fascia solo quando
// quel bordo è un impegno reale (pausa/prenotazione) — non quando è la
// chiusura della griglia: lì ogni servizio può ancora iniziare fino a
// lastStart, regola di business ereditata dal fix "20:30 closing-slot"
// (un servizio da 45 min può iniziare proprio alle 20:30 e sforare oltre).
// Sostituisce il vecchio sistema a griglia fissa da 30 min: ora qualsiasi
// orario (a step di minuti liberi) può essere proposto/validato.
function freeRangesFor(salon,workerId,iso,durMin){
  const worker=(salon.workers||[]).find(x=>x.id===workerId);
  if(worker&&isWeeklyOff(worker,iso))return[];
  const mins=((salon&&salon.timeSlots)||DEFAULT_SLOTS).map(timeToMin).filter(v=>v!==null);
  const openMin=Math.min(...mins),lastStart=Math.max(...mins);
  const merged=mergeIntervals(busyIntervalsFor(salon.id,iso,workerId));
  const ranges=[];
  let cursor=openMin;
  for(const b of merged){
    if(cursor>lastStart)break;
    if(b.start>=cursor){
      const end=Math.min(b.start-durMin,lastStart);
      if(end>=cursor)ranges.push({start:cursor,end});
    }
    cursor=Math.max(cursor,b.end);
  }
  if(cursor<=lastStart)ranges.push({start:cursor,end:lastStart});
  return ranges;
}
function isTimeInRanges(t,ranges){
  const m=timeToMin(t);
  return m!==null&&ranges.some(r=>m>=r.start&&m<=r.end);
}
// Presenta gli orari come lista fissa a 30 min (i clienti, secondo i test,
// trovano più comodo scegliere da una lista che digitare ora+minuti): ogni
// marca della griglia del salone viene offerta solo se ricade in una fascia
// libera calcolata da freeRangesFor — quindi una pausa non allineata alla
// griglia (es. 12:15-12:45) nasconde correttamente sia le 12:00 che le
// 12:30, invece di ignorarla come faceva il vecchio freeTimesFor.
function freeGridTimesFor(salon,workerId,iso,durMin){
  const ranges=freeRangesFor(salon,workerId,iso,durMin);
  if(!ranges.length)return[];
  const mins=((salon&&salon.timeSlots)||DEFAULT_SLOTS).map(timeToMin).filter(v=>v!==null);
  return mins.filter(m=>isTimeInRanges(minToTime(m),ranges)).map(minToTime);
}
function slotConflicts(salonId,workerId,iso,time,durMin){
  const s=timeToMin(time);
  if(s===null)return true;
  return busyIntervalsFor(salonId,iso,workerId).some(b=>s<b.end&&s+durMin>b.start);
}

/* ======== TELEFONO (formato italiano) ========
   Normalizza in "+39 3XX XXX XXXX": accetta numeri nudi (345..., 06...),
   il prefisso internazionale scritto come 0039 o +39, e lascia intatti i
   numeri esteri (+355, +41, ...) limitandosi a raggrupparli. */
function formatItalianPhone(raw){
  let v=(raw||'').replace(/[^\d+]/g,'');
  if(!v)return '';
  if(v.startsWith('00'))v='+'+v.slice(2);
  if(!v.startsWith('+'))v='+39'+v;
  const cc=v.startsWith('+39')?'+39':(v.match(/^\+\d{1,3}/)||['+39'])[0];
  const d=v.slice(cc.length);
  let out=cc;
  if(d)out+=' '+d.slice(0,3);
  if(d.length>3)out+=' '+d.slice(3,6);
  if(d.length>6)out+=' '+d.slice(6,11);
  return out;
}
function isValidItalianPhone(formatted){
  const v=(formatted||'').trim();
  if(!v)return true; // facoltativo
  const digits=v.replace(/\D/g,'');
  if(v.startsWith('+39')){
    const n=digits.slice(2);
    // cellulare 3xx (9-10 cifre) o fisso 0xx (8-11 cifre)
    return /^3\d{8,9}$/.test(n)||/^0\d{7,10}$/.test(n);
  }
  return /^\d{8,15}$/.test(digits); // numero estero: solo lunghezza sensata
}
function bookingsFor(salonId,workerId=null){
  let bks=STATE.bookings.filter(b=>b.salonId===salonId);
  if(workerId)bks=bks.filter(b=>b.workerId===workerId);
  return bks;
}

/* ======== DAYS / CHIPS ======== */
function openDays(salon){
  const today=new Date();const out=[];let added=0,off=0;
  const cd=salon.closedDays||[];const bd=salon.bookingDays||30;
  while(added<bd&&off<90){
    const d=new Date(today);d.setDate(today.getDate()+off);off++;
    if(cd.includes(d.getDay()))continue;
    const iso=d.toISOString().split('T')[0];
    out.push({iso,label:`${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`,isToday:added===0});
    added++;
  }
  return out;
}
function buildChips(el,salon,onPick){
  const days=openDays(salon);let html='';let lastM=null;
  days.forEach(d=>{
    const dt=new Date(d.iso+'T00:00:00');const m=dt.getMonth();
    if(lastM!==null&&m!==lastM)html+=`<div class="month-sep"><span class="ms-line"></span><span class="ms-lbl">${MON[m]}</span><span class="ms-line"></span></div>`;
    lastM=m;
    html+=`<div class="chip" data-iso="${d.iso}" data-label="${d.label}">
      <div class="dow">${d.isToday?'Oggi':DOW[dt.getDay()]}</div>
      <div class="dn">${dt.getDate()}</div><div class="mo">${MON[m]}</div></div>`;
  });
  el.innerHTML=html;
  el.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{
    el.querySelectorAll('.chip').forEach(x=>x.classList.remove('sel'));
    c.classList.add('sel');onPick(c.dataset.iso,c.dataset.label);
  }));
}

/* ================================================================
   LIVELLO 4 — CLIENTE
================================================================ */
let custStep=0;
const custData={barberId:null,barberName:null,dateISO:null,dateLabel:null,time:null,service:null,price:null,name:null,phone:null};
let custSalon=null;
let lastBookingId=null;

// Remembers which bookings THIS device made (booking ids only — the actual
// data is always re-fetched live from STATE.bookings, so status changes made
// by the salon show up automatically) so the customer can find their
// appointment again after closing/reopening the Home-Screen app, without an
// account system. Capped so a device used at many salons over time doesn't
// grow this forever.
const MY_BOOKINGS_KEY='trimio_my_bookings';
function rememberMyBooking(id){
  if(!canStore)return;
  try{
    let ids=JSON.parse(localStorage.getItem(MY_BOOKINGS_KEY)||'[]');
    ids=ids.filter(x=>x!==id);
    ids.push(id);
    if(ids.length>30)ids=ids.slice(-30);
    localStorage.setItem(MY_BOOKINGS_KEY,JSON.stringify(ids));
  }catch(e){}
}
function getMyBookingsForSalon(salonId){
  if(!canStore)return[];
  let ids=[];
  try{ids=JSON.parse(localStorage.getItem(MY_BOOKINGS_KEY)||'[]');}catch(e){}
  if(!ids.length)return[];
  const today=new Date(todayISO()+'T00:00:00');
  return(STATE.bookings||[])
    // A booking the customer cancelled themselves drops out of their own
    // list entirely (they already know); one the salon cancelled stays
    // visible, tagged "Annullata", since that's news to them.
    .filter(b=>b.salonId===salonId&&ids.includes(b.id)&&!(b.status==='cancelled'&&b.cancelledBy==='customer'))
    // Nearest to today first (whichever direction, upcoming or past), not
    // simply newest-first — the closest appointment in time is the most
    // relevant one to see at the top of the list.
    .sort((a,b)=>{
      const da=Math.abs(new Date(a.dateISO+'T00:00:00')-today);
      const db=Math.abs(new Date(b.dateISO+'T00:00:00')-today);
      if(da!==db)return da-db;
      return a.time.localeCompare(b.time);
    });
}

// Keep the PWA manifest's start_url pointed at the page currently shown, so
// "Aggiungi alla schermata Home" installs an app that reopens THIS page
// (e.g. /#BARBER_ART) instead of the root admin login. This is the fix that
// actually works on iOS: the installed app has its own separate localStorage,
// so a stored slug can't cross over from Safari — only the captured URL can.
function updateManifestLink(){
  // The salon lives in the URL PATH (/s/SLUG). iOS "Aggiungi alla schermata
  // Home" saves the loaded document URL stripped of the #fragment (and on
  // some versions of the ?query too) and ignores history.replaceState — a
  // path is the only part that survives every iOS version.
  const h=(location.hash||'').replace('#','');
  const isSalon=!!h&&h.indexOf('admin/')!==0;
  const link=document.querySelector('link[rel="manifest"]');
  if(link){
    const start=isSalon?('/s/'+encodeURIComponent(h)):'/';
    link.href='/api/manifest?start='+encodeURIComponent(start);
  }
  // If this document's real URL doesn't already carry the shown salon in its
  // path (e.g. homepage -> tapped a salon, or an old ?s=/#hash link), re-enter
  // it once with a REAL navigation so Add to Home Screen captures /s/SLUG.
  if(isSalon&&DOC_PATH_SLUG!==h){
    try{location.replace('/s/'+encodeURIComponent(h)+'#'+h);return;}catch(e){}
  }
}
// The salon slug embedded in THIS document's real URL path (what iOS saves
// on Add to Home Screen). Evaluated before any history API call runs.
const DOC_PATH_SLUG=(()=>{try{const m=location.pathname.match(/^\/s\/([^\/]+)\/?$/);return m?decodeURIComponent(m[1]):'';}catch(e){return '';}})();

// Hero del salone: con una sola foto è statico, con più foto (bgImage +
// gallery) diventa un carosello automatico con puntini cliccabili.
let custHeroTimer=null;
function initCustHero(salon){
  const realPhotos=[salon.bgImage,...(salon.gallery||[])].filter(Boolean);
  const photos=realPhotos.length?realPhotos.slice():['https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&q=70&fit=crop'];
  const bg=$('custHeroBg'),dots=$('custHeroDots');
  if(custHeroTimer){clearInterval(custHeroTimer);custHeroTimer=null;}
  let idx=0;
  const show=i=>{
    idx=i;
    bg.style.backgroundImage=`url('${photos[i]}')`;
    if(dots)dots.querySelectorAll('span').forEach((d,k)=>{d.style.background=k===i?'var(--gold)':'rgba(255,255,255,0.45)';});
  };
  if(dots){
    dots.style.display=photos.length>1?'flex':'none';
    dots.innerHTML=photos.length>1?photos.map((_,i)=>`<span data-i="${i}" style="width:7px;height:7px;border-radius:50%;cursor:pointer;"></span>`).join(''):'';
    dots.querySelectorAll('span').forEach(d=>d.addEventListener('click',()=>show(+d.dataset.i)));
  }
  show(0);
  if(photos.length>1)custHeroTimer=setInterval(()=>show((idx+1)%photos.length),4000);
  renderCustGalleryStrip(realPhotos);
}

// Miniature chiare delle foto del salone, sotto l'hero — la versione nell'hero
// è a opacità 20% (sfondo del titolo), quasi invisibile: qui il cliente vede
// le foto per davvero. Nascosta quando il salone non ha foto proprie.
function renderCustGalleryStrip(realPhotos){
  const strip=$('custGalleryStrip');
  if(!strip)return;
  if(!realPhotos.length){strip.style.display='none';strip.innerHTML='';return;}
  strip.style.display='flex';
  strip.innerHTML=realPhotos.map((u,i)=>`<img src="${u}" data-i="${i}" alt="Foto salone" style="width:84px; height:84px; flex-shrink:0; border-radius:12px; object-fit:cover; cursor:pointer; background:#f4f4f5;">`).join('');
  const lightbox=$('custGalleryLightbox'),lightboxImg=$('custGalleryLightboxImg');
  strip.querySelectorAll('img').forEach(img=>img.addEventListener('click',()=>{
    lightboxImg.src=realPhotos[+img.dataset.i];
    lightbox.style.display='flex';
  }));
}

// Per-salon accent color, scoped to #vCustomer only (CSS custom properties
// cascade to descendants, not siblings) so the admin dashboard keeps gold
// regardless of which salon's page was last viewed. Must be re-applied every
// time custSalon is refreshed from the cloud sync (not just on initial
// initCustomer()), or a salon's theme color would never show up until the
// customer manually reloads the page.
function applyCustomerTheme(salon){
  const hex=salon.themeColor||'#e5c158';
  const preset=SALON_THEME_PALETTE.find(c=>c.hex===hex);
  const rgb=preset?preset.rgb:'229,193,88';
  const el=$('vCustomer');
  el.style.setProperty('--gold', hex);
  el.style.setProperty('--gold-rgb', rgb);
}

function initCustomer(salon){
  custSalon=salon;
  // Remember the last salon page visited: a Home-Screen/PWA launch loses the
  // #SLUG hash (manifest start_url), so boot restores it from here instead of
  // dumping the customer on the admin login screen.
  if(canStore){try{localStorage.setItem('trimio_last_salon_slug',salon.slug);}catch(e){}}
  updateManifestLink();
  $('hBrand').textContent=salon.name;
  $('hSlug').textContent='#'+salon.slug;$('hSlug').style.display='inline-block';
  applyCustomerTheme(salon);

  // Set Salon booking page hero elements
  $('custHeroTitle').textContent = salon.name;
  $('custHeroAddress').textContent = salon.address ? `📍 ${salon.address}, ${salon.city || '—'}` : `📍 ${salon.city || '—'}`;
  initCustHero(salon);

  custStep=0;Object.keys(custData).forEach(k=>custData[k]=null);
  renderCustStep();renderBarberGrid();
  renderCustMyBookingBanner();
}

// Shows a compact "you already have a booking" card at the top of the
// booking flow — the whole point is that it's visible the moment the
// customer reopens the Home-Screen app, without hunting through a menu.
// Headlines the soonest upcoming, non-cancelled booking; the click-through
// modal (below) lists everything this device has ever booked here.
function renderCustMyBookingBanner(){
  const banner=$('custMyBookingBanner');
  if(!banner||!custSalon)return;
  const mine=getMyBookingsForSalon(custSalon.id);
  if(!mine.length){banner.style.display='none';return;}
  const today=todayISO();
  const upcoming=mine.filter(b=>b.status!=='cancelled'&&b.dateISO>=today)
    .sort((a,b)=>(a.dateISO+a.time).localeCompare(b.dateISO+b.time))[0];
  // With an upcoming booking, headline its date/time; otherwise (only
  // past/cancelled ones on record) keep the banner as a generic entry point
  // instead of hiding it — the point of this banner is that "my bookings"
  // stays reachable at any time without a menu, not just while something's
  // still upcoming.
  const upcomingEnd=upcoming?bookingEndTime(custSalon,upcoming.service,upcoming.time):null;
  $('custMyBookingBannerText').textContent=upcoming
    ?`${upcoming.dateLabel} alle ${upcoming.time}${upcomingEnd?'-'+upcomingEnd:''} · ${upcoming.workerName}`
    :'Vedi lo storico delle tue prenotazioni';
  banner.style.display='flex';
}

function renderMyBookingsModal(){
  if(!custSalon)return;
  const mine=getMyBookingsForSalon(custSalon.id);
  $('myBookingsList').innerHTML=mine.length?mine.map(b=>{
    const end=bookingEndTime(custSalon,b.service,b.time);
    return`
    <div class="acard ${b.status==='completed'?'completed':b.status==='cancelled'?'cancelled':''}">
      <div class="acard-main">
        <div class="acard-info">
          <div class="acard-name">${escapeHtml(b.workerName)}</div>
          <div class="acard-svc">${escapeHtml(b.service)}${b.status==='cancelled'?' · Annullata':b.status==='completed'?' · Completata':''}</div>
        </div>
        <div class="acard-right">
          <div class="acard-time">${end?`${b.time}-${end}`:b.time}</div>
          <div class="acard-price" style="color:#71717a;">${b.dateLabel}</div>
        </div>
      </div>
      ${b.status==='confirmed'?`<div class="acard-acts"><button class="act" data-cancel-mybk="${b.id}">Annulla prenotazione</button></div>`:''}
    </div>`;
  }).join(''):'<div style="font-size:13px; color:#888; text-align:center; padding:20px 0;">Nessuna prenotazione trovata su questo dispositivo.</div>';
  $('myBookingsList').querySelectorAll('[data-cancel-mybk]').forEach(btn=>{
    btn.addEventListener('click',()=>customerCancelBooking(btn.dataset.cancelMybk,btn));
  });
  openModal('myBookingsModal');
}

// Re-entry guard mirrors doSubmit()'s custSubmitting: prevents a slow save
// from being triggered twice by a fast double-tap on the cancel button.
let custCancelling=false;
async function customerCancelBooking(id,btn){
  if(custCancelling)return;
  const b=(STATE.bookings||[]).find(x=>x.id===id);
  if(!b||b.status!=='confirmed')return;
  if(!confirm(`Annullare la prenotazione del ${b.dateLabel} alle ${b.time}?`))return;
  custCancelling=true;
  const original=btn.textContent;
  btn.disabled=true;btn.textContent='...';
  b.status='cancelled';b.cancelledBy='customer';
  try{
    const r=await saveState();
    if(!r.ok){
      b.status='confirmed';delete b.cancelledBy;
      alert('Impossibile annullare la prenotazione, riprova.');
    }
  }catch(e){
    b.status='confirmed';delete b.cancelledBy;
    alert('Impossibile annullare la prenotazione, riprova.');
  }finally{
    custCancelling=false;
    renderCustMyBookingBanner();
    renderMyBookingsModal();
  }
}

function renderBarberGrid(){
  const iso=todayISO();
  $('barberGrid').innerHTML=custSalon.workers.map(w=>{
    const vac=isOnVacation(w,iso);
    const reviews=w.reviews || [];
    const count=reviews.length;
    const avg=count ? (reviews.reduce((sum, r) => sum + r.rating, 0) / count).toFixed(1) : 'Nuovo';
    const starsHtml=count ? `★ ${avg} (${count})` : '★ Nuova scheda';
    
    // First name only
    const firstName = w.name.split(' ')[0];
    
    return`<div class="barber-card${vac?' on-vacation':''}" data-id="${w.id}">
      <div class="bc-img-container">
        <img src="${w.img || 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face'}" alt="${firstName}" class="bc-img">
      </div>
      <div class="bc-name">${firstName}</div>
      <div class="bc-role">${w.role || 'Senior Barber'}</div>
      <div class="bc-desc">${w.desc || 'Specialista in taglio e rasatura.'}</div>
      <div class="bc-stars" onclick="event.stopPropagation(); showBarberReviews('${w.id}')">${starsHtml}</div>
      <div class="bc-status">${vac?'In ferie 🌴':'Disponibile'}</div>
      ${vac&&w.vacTo?`<div class="bc-vac">Fino al ${w.vacTo}</div>`:''}
      ${!vac&&offDaysLabel(w)?`<div class="bc-vac">Riposo: ${offDaysLabel(w)}</div>`:''}
    </div>`;
  }).join('');
  $('barberGrid').querySelectorAll('.barber-card:not(.on-vacation)').forEach(el=>el.addEventListener('click',()=>{
    $('barberGrid').querySelectorAll('.barber-card').forEach(x=>x.classList.remove('sel'));
    el.classList.add('sel');
    const w=custSalon.workers.find(x=>x.id===el.dataset.id);
    custData.barberId=el.dataset.id;custData.barberName=w?w.name:'';clearErr('cErr');
    
    // Auto-advance to Step 1 (Calendar & Time) after a slight delay
    setTimeout(() => {
      custStep = 1;
      renderCustStep();
    }, 180);
  }));
}

function renderCustTimes(){
  // Orari calcolati sulla durata del servizio scelto (per questo il servizio
  // viene ora scelto PRIMA dell'orario), indipendenti per ogni barbiere.
  // Lista fissa a 30 min (vedi freeGridTimesFor) — i clienti la trovano più
  // comoda da scegliere rispetto a digitare ora+minuti liberamente.
  const dur=serviceDurMin(custSalon,custData.service);
  let times=freeGridTimesFor(custSalon,custData.barberId,custData.dateISO,dur);

  if(custData.dateISO===todayISO()){
    const now=new Date();
    const nowStr=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    times=times.filter(t=>t>=nowStr);
  }

  if(!times.length){
    const w=custSalon.workers.find(x=>x.id===custData.barberId);
    const restMsg=w&&isWeeklyOff(w,custData.dateISO)
      ? `${custData.barberName.split(' ')[0]} riposa in questo giorno.<br>Scegli un altro giorno o un altro barbiere.`
      : `Nessun orario disponibile per questo giorno.<br>Prova un altro giorno o un altro barbiere.`;
    $('times').innerHTML=`<div class="empty" style="grid-column:1/-1"><div class="empty-t">${restMsg}</div></div>`;
    return;
  }

  $('times').innerHTML=times.map(t=>`<div class="slot${custData.time===t?' sel':''}" data-t="${t}">${t}</div>`).join('');

  $('times').querySelectorAll('.slot').forEach(el=>el.addEventListener('click',()=>{
    $('times').querySelectorAll('.slot').forEach(x=>x.classList.remove('sel'));
    el.classList.add('sel');custData.time=el.dataset.t;clearErr('cErr');

    // Auto-advance to confirmation after a slight delay
    setTimeout(() => {
      custStep = 3;
      renderCustStep();
    }, 180);
  }));
}

function renderCustServices(){
  const svcs=custSalon.services||DEFAULT_SERVICES;
  $('svc').innerHTML=svcs.map(s=>`<div class="svc-item" data-name="${s.name}" data-price="${s.price}">
    <div><div class="svc-name">${s.name}</div><div class="svc-meta">${s.dur}</div></div>
    <div class="svc-price">€${s.price}</div></div>`).join('');
  $('svc').querySelectorAll('.svc-item').forEach(el=>el.addEventListener('click',()=>{
    $('svc').querySelectorAll('.svc-item').forEach(x=>x.classList.remove('sel'));
    el.classList.add('sel');custData.service=el.dataset.name;custData.price=parseInt(el.dataset.price);
    // La durata del servizio determina gli orari proposti: un orario scelto
    // in precedenza per un altro servizio potrebbe non essere più valido.
    custData.time=null;
    clearErr('cErr');

    // Auto-advance to date & time after a slight delay
    setTimeout(() => {
      custStep = 2;
      renderCustStep();
    }, 180);
  }));
}

function renderCustStep(){
  clearErr('cErr');clearInfo('cInfo');
  ['s0','s1','s2','s3','sDone'].forEach(id=>$(id).classList.remove('on'));
  // Ordine dei passi: barbiere (s0) → servizio (s2) → data e orario (s1) →
  // conferma (s3). Il servizio viene PRIMA dell'orario perché la sua durata
  // determina quali orari sono proponibili.
  const STEP_EL=['s0','s2','s1','s3'];
  $(STEP_EL[Math.min(custStep,3)]).classList.add('on');
  document.querySelectorAll('#vCustomer .dots .dot').forEach((d,i)=>d.classList.toggle('on',i<=custStep));
  // Restore the action bar hidden by the confirmation screen — without this,
  // starting a new booking after a completed one left the page with no
  // Avanti/Conferma buttons at all.
  $('cActions').style.display='';
  $('cBack').style.display=custStep>0?'block':'none';
  $('cNext').style.display='block';
  $('cNext').disabled=false;
  $('cNext').textContent=custStep===3?'✓ Conferma':'Avanti →';
  $('cFooter').style.display=custStep===0?'block':'none';
  if(custStep===1)renderCustServices();
  if(custStep===2){
    buildChips($('dates'),custSalon,(iso,label)=>{custData.dateISO=iso;custData.dateLabel=label;custData.time=null;renderCustTimes();clearErr('cErr');});
    const first=$('dates').querySelector('.chip');if(first)first.click();
  }
  if(custStep===3){
    $('rB').textContent=custData.barberName;$('rD').textContent=custData.dateLabel;
    $('rT').textContent=custData.time+' · '+serviceDurMin(custSalon,custData.service)+' min';
    $('rS').textContent=custData.service;$('rP').textContent='€'+custData.price;
  }
}

function custNext(){if(!validateCust())return;if(custStep===3){doSubmit();return;}custStep++;renderCustStep();}
function custBack(){if(custStep>0){custStep--;renderCustStep();}}

function validateCust(){
  const s=custStep;
  if(s===0&&!custData.barberId)return showErr('cErr','Seleziona un barbiere');
  if(s===1&&!custData.service)return showErr('cErr','Seleziona un servizio');
  if(s===2){
    if(!custData.dateISO)return showErr('cErr','Seleziona un giorno');
    if(!custData.time)return showErr('cErr','Seleziona un orario');
    if(custData.dateISO === todayISO()){
      const now = new Date();
      const currentTimeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      if(custData.time < currentTimeStr) {
        return showErr('cErr','Questo orario è già passato. Seleziona un altro orario.');
      }
    }
  }
  if(s===3){
    if(!custData.name||custData.name.trim().length<2)return showErr('cErr','Inserisci il tuo nome');
    if(!(custData.phone||'').trim())return showErr('cErr','Inserisci il tuo numero di telefono');
    const formatted=formatItalianPhone(custData.phone);
    if(!isValidItalianPhone(formatted))return showErr('cErr','Numero di telefono non valido. Es. +39 345 678 9012');
    custData.phone=formatted;
    $('cphone').value=formatted;
  }
  return true;
}

// Re-entry guard: doSubmit awaits a network save that can take seconds. A
// second tap on "✓ Conferma" in that window used to re-run the whole flow,
// see the customer's OWN just-pushed booking in the local slot check, and pop
// the "choose another time" modal on top of a booking that had actually
// succeeded. One submission at a time, with the button disabled meanwhile.
let custSubmitting=false;
async function doSubmit(){
  if(custSubmitting)return;
  custSubmitting=true;
  const nextBtn=$('cNext');
  nextBtn.disabled=true;
  nextBtn.textContent='…';
  try{
    const durMin=serviceDurMin(custSalon,custData.service);
    if(slotConflicts(custSalon.id,custData.barberId,custData.dateISO,custData.time,durMin)){
      // cerca barbieri alternativi liberi
      const free=custSalon.workers.filter(w=>{
        if(w.id===custData.barberId)return false;
        if(isOnVacation(w,custData.dateISO))return false;
        if(isWeeklyOff(w,custData.dateISO))return false;
        return!slotConflicts(custSalon.id,w.id,custData.dateISO,custData.time,durMin);
      });
      nextBtn.disabled=false;
      nextBtn.textContent='✓ Conferma';
      showAltModal(custData.barberName,custData.time,free);
      return;
    }
    const bk={
      id:'bk'+Date.now()+Math.random().toString(36).slice(2,6),
      salonId:custSalon.id,workerId:custData.barberId,workerName:custData.barberName,
      name:custData.name.trim(),phone:(custData.phone||'').trim(),dateISO:custData.dateISO,dateLabel:custData.dateLabel,
      time:custData.time,service:custData.service,price:custData.price,dur:durMin,
      status:'confirmed',source:'online',createdAt:new Date().toISOString()
    };
    STATE.bookings.push(bk);
    const r=await saveState();

    if(r.conflicts.some(c=>c.id===bk.id)){
      // Un altro cliente ha preso questo slot nel frattempo (rilevato dal server)
      STATE.bookings=STATE.bookings.filter(x=>x.id!==bk.id);
      const free=custSalon.workers.filter(w=>{
        if(w.id===custData.barberId)return false;
        if(isOnVacation(w,custData.dateISO))return false;
        if(isWeeklyOff(w,custData.dateISO))return false;
        return!slotConflicts(custSalon.id,w.id,custData.dateISO,custData.time,durMin);
      });
      nextBtn.disabled=false;
      nextBtn.textContent='✓ Conferma';
      showAltModal(custData.barberName,custData.time,free);
      return;
    }
    if(!r.ok){
      STATE.bookings=STATE.bookings.filter(x=>x.id!==bk.id);
      nextBtn.disabled=false;
      nextBtn.textContent='✓ Conferma';
      showErr('cErr','Impossibile completare la prenotazione, riprova.');
      return;
    }

    $('dB').textContent=custData.barberName;$('dD').textContent=custData.dateLabel;
    $('dT').textContent=custData.time+' · '+durMin+' min';$('dS').textContent=custData.service;
    ['s0','s1','s2','s3'].forEach(id=>$(id).classList.remove('on'));
    $('sDone').classList.add('on');
    $('cActions').style.display='none';$('cFooter').style.display='none';
    document.querySelectorAll('#vCustomer .dots .dot').forEach(d=>d.classList.add('on'));
    lastBookingId=bk.id;
    rememberMyBooking(bk.id);
    renderCustMyBookingBanner();
    // Il permesso notifiche è già stato concesso in una prenotazione
    // precedente → riattiva il promemoria per QUESTA prenotazione in
    // silenzio, senza chiedere di nuovo "Attiva".
    let reminderAuto=false;
    if(typeof Notification!=='undefined'&&Notification.permission==='granted'){
      try{reminderAuto=await initCustomerPushNotifications(bk.id);}catch(e){}
    }
    renderCustReminderBanner(reminderAuto);
  } finally {
    custSubmitting=false;
  }
}

function showAltModal(busyName,time,freeB){
  $('altSub').textContent=`${busyName} è occupato alle ${time}. Liberi in questo orario:`;
  $('altList').innerHTML=freeB.length===0
    ?`<div style="padding:14px 0;color:#888;font-size:13px">Nessun altro barbiere libero in questo orario.</div>`
    :freeB.map(w=>`<div class="alt-item" data-id="${w.id}" data-name="${w.name}">
      <div class="alt-av">${initials(w.name)}</div>
      <div><div class="alt-name">${w.name}</div><div style="font-size:12px;color:#888;margin-top:2px">Libero alle ${time}</div></div>
    </div>`).join('');
  $('altList').querySelectorAll('.alt-item').forEach(el=>el.addEventListener('click',()=>{
    custData.barberId=el.dataset.id;custData.barberName=el.dataset.name;
    closeAlt();doSubmit();
  }));
  $('altModal').classList.add('show');
}
function closeAlt(){$('altModal').classList.remove('show');}

/* ======== INTERFACCIA TABS MODAL SALONE ======== */
function initSalonModalTabs() {
  const tabs = ['tabSalonInfo', 'tabSalonStaff', 'tabSalonServices'];
  const panels = ['panelSalonInfo', 'panelSalonStaff', 'panelSalonServices'];
  
  tabs.forEach((tabId, idx) => {
    const btn = $(tabId);
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      tabs.forEach(t => $(t).classList.remove('active'));
      panels.forEach(p => $(p).style.display = 'none');
      btn.classList.add('active');
      $(panels[idx]).style.display = 'block';
    });
  });
}

function renderSalonModalWorkers(s) {
  const container = $('smWorkersList');
  if (!container) return;
  
  if (!s.workers || !s.workers.length) {
    container.innerHTML = `<div style="text-align:center; padding:18px; color:#888; font-size:12px;">Nessun barbiere in questo salone.</div>`;
    return;
  }
  
  container.innerHTML = s.workers.map(w => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:8px; border-bottom:1px solid #e4e4e7; font-size:13px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <div style="width:32px; height:32px; border-radius:50%; background:#e5c158; color:#000; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; flex-shrink:0;">
          ${initials(w.name)}
        </div>
        <div>
          <div style="font-weight:700; color:#18181b;">${w.name}</div>
          <div style="font-size:11px; color:#71717a;">@${w.username}</div>
        </div>
      </div>
      <div style="display:flex; gap:6px;">
        <button type="button" class="btn btn-ghost" data-smwedit="${w.id}" style="padding:4px 8px; font-size:11px; border:1px solid #ccc; border-radius:6px; background:#fff;">Modifica</button>
        <button type="button" class="btn btn-ghost" data-smwbreak="${w.id}" style="padding:4px 8px; font-size:11px; border:1px solid #ccc; border-radius:6px; background:#fff;">🕐 Pause</button>
        <button type="button" class="btn btn-ghost" data-smwdel="${w.id}" style="padding:4px 8px; font-size:11px; color:#ef4444; border:1px solid #fecaca; border-radius:6px; background:#fff;">Elimina</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-smwedit]').forEach(btn => btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const salon = STATE.salons.find(x => x.id === s.id);
    if (salon) openWorkerModal(btn.dataset.smwedit, salon);
  }));
  container.querySelectorAll('[data-smwbreak]').forEach(btn => btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const salon = STATE.salons.find(x => x.id === s.id);
    if (salon) openBreakModal(btn.dataset.smwbreak, salon);
  }));
  container.querySelectorAll('[data-smwdel]').forEach(btn => btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    deleteSalonModalWorker(btn.dataset.smwdel, s.id);
  }));
}

function deleteSalonModalWorker(wid, sid) {
  if (!confirm('Eliminare questo dipendente?')) return;
  const s = STATE.salons.find(x => x.id === sid);
  if (s && s.workers) {
    s.workers = s.workers.filter(w => w.id !== wid);
    saveState();
    renderSalonModalWorkers(s);
    renderDipendenti();
  }
}

function renderSalonModalServices(s) {
  const container = $('smServicesList');
  if (!container) return;
  
  const svcs = s.services || DEFAULT_SERVICES;
  container.innerHTML = svcs.map(svc => `
    <div class="sm-svc-item" style="display:flex; align-items:center; gap:10px; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid #e4e4e7;">
      <div style="flex:2; font-size:13px; font-weight:700; color:#18181b;">${svc.name}</div>
      <div style="flex:1;">
        <label style="font-size:10px; color:#71717a; display:block; margin-bottom:2px;">Prezzo (€)</label>
        <input type="number" class="minput sm-svc-price" data-name="${svc.name}" value="${svc.price}" style="margin-bottom:0; padding:6px 8px; font-size:12px; border-radius:6px; border:1px solid #ccc;">
      </div>
      <div style="flex:1;">
        <label style="font-size:10px; color:#71717a; display:block; margin-bottom:2px;">Durata</label>
        <input type="text" class="minput sm-svc-dur" data-name="${svc.name}" value="${svc.dur}" style="margin-bottom:0; padding:6px 8px; font-size:12px; border-radius:6px; border:1px solid #ccc;">
      </div>
    </div>
  `).join('');
}


function doLogout(){
  SESSION={role:null,salonId:null,workerId:null,name:null};
  if ((location.hash||'').replace('#','').startsWith('admin/')) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch(e) { location.hash = ''; }
  }
  if (canStore) {
    try { localStorage.removeItem(SESSION_KEY); } catch(e) {}
  }
  if (custSalon) {
    initCustomer(custSalon);
    showView('vCustomer');
  } else {
    showView('vLogin');
  }
  updateNavMenu();
}

function updateNavMenu() {
  const menu = $('navMenu');
  if (!menu) return;

  // A salon's customer page must always show the customer menu — never the
  // admin/staff one — no matter what session happens to be sitting in this
  // browser (e.g. an admin/owner/barber session left over from earlier use
  // on the same phone). Same rule as the header back-arrow and logo fixes:
  // unconditional, no session-based exception, so a visitor scanning a QR
  // code never lands on "Pannello Admin" by accident.
  const onCustomerPage = document.querySelector('.view.on')?.id === 'vCustomer';
  const SESSION_FOR_MENU = onCustomerPage ? null : SESSION;

  // The marketing entry point must show no trace of an admin session —
  // no menu, no shortcut into the dashboard — the whole point is that it
  // reads identically to every visitor and the only way in is the actual
  // login modal. Checked before the admin-role branch below so a
  // persisted admin session on this exact page doesn't leak through it.
  const onGenericLogin = document.querySelector('.view.on')?.id === 'vLogin' && !loginSalonContext;
  if (onGenericLogin) {
    menu.style.display = 'none';
    menu.innerHTML = '';
    return;
  }
  // Admin has exactly ONE navigation: the dashboard sidebar. This header
  // dropdown must never duplicate its sections — while on the public
  // Homepage it only offers the single way INTO the dashboard (plus logout),
  // and inside the dashboard it's hidden entirely.
  if (SESSION_FOR_MENU && SESSION_FOR_MENU.role === 'admin') {
    const onDash = document.querySelector('.view.on')?.id === 'vDash';
    if (onDash) {
      menu.style.display = 'none';
      menu.innerHTML = '';
    } else {
      menu.style.display = '';
      menu.innerHTML = `
        <option value="" disabled selected>☰ Menu</option>
        <option value="dashboard">🗂️ Pannello Admin</option>
        <option value="logout">🚪 Esci</option>
      `;
    }
    return;
  }
  // The login screen is a dead-end entry point on its own (no salon list or
  // booking flow to navigate to from there) — the "Menu Navigazione"
  // dropdown was redundant clutter on it.
  if (document.querySelector('.view.on')?.id === 'vLogin') {
    menu.style.display = 'none';
    menu.innerHTML = '';
    return;
  }
  menu.style.display = '';

  let html = '';

  if (!SESSION_FOR_MENU || !SESSION_FOR_MENU.role) {
    // Guest / Customer level
    if (custSalon && custSalon.name) {
      // Specific Salon page context (remove home option) — "Le mie
      // prenotazioni" lives only in the automatic banner on the page
      // itself, not duplicated here in the menu.
      html += `
        <option value="" disabled selected>☰ Menu: ${custSalon.name}</option>
        <option value="booking">📅 Prenota in questo Salone</option>
        <option value="login_owner">🔑 Login Proprietario (Owner)</option>
        <option value="login_barber">🔑 Login Staf / Barbiere</option>
      `;
    } else {
      // Main Homepage context — simplified to just the admin entry point;
      // the other options duplicated what's already reachable directly from
      // the homepage itself.
      html += `
        <option value="" disabled selected>☰ Menu Navigazione</option>
        <option value="login_admin">🔑 Login Amministratore</option>
      `;
    }
  } else {
    // Logged in user level (owner / barber — admin already handled above)
    const roleLabel = SESSION_FOR_MENU.role === 'owner' ? 'Owner' : 'Staf';
    const nameLabel = SESSION_FOR_MENU.name ? SESSION_FOR_MENU.name.split(' ')[0] : '';
    html += `
      <option value="" disabled selected>👤 ${roleLabel}: ${nameLabel}</option>
      <option value="logout">🚪 Esci (Logout)</option>
      <option value="dashboard">📊 Vai alla Dashboard</option>
    `;

    if (SESSION_FOR_MENU.role === 'owner') {
      html += `
        <option value="" disabled>--- Sezioni Owner ---</option>
        <option value="nav_oggi">📅 Appuntamenti Oggi</option>
        <option value="nav_calendario">📅 Calendario Completo</option>
        <option value="nav_dipendenti">👥 Gestione Staf</option>
        <option value="nav_stats">📊 Statistiche Salone</option>
        <option value="nav_recensioni">⭐ Recensioni Ricevute</option>
      `;
    } else if (SESSION_FOR_MENU.role === 'barber') {
      html += `
        <option value="" disabled>--- Sezioni Staf ---</option>
        <option value="nav_oggi">📅 Appuntamenti Oggi</option>
        <option value="nav_calendario">📅 Calendario Completo</option>
        <option value="nav_recensioni">⭐ Mie Recensioni</option>
      `;
    }
  }
  
  menu.innerHTML = html;
}

// Header logo click: normally clears the hash to go "home" — but on a
// salon's customer page, clearing the hash falls through the hashchange
// handler to either the staff login screen or the admin homepage,
// depending on whatever session state happens to be sitting in this
// browser. Same rule as the header back-arrow: unconditional, no
// session-based exception — a visitor on a salon page must never be one
// tap away from admin/staff territory. Staff/admin use the nav menu's
// "Vai alla Dashboard" instead.
function onHeaderLogoClick(){
  if(document.querySelector('.view.on')?.id==='vCustomer')return;
  location.hash='';
}

/* ================================================================
   VIEW SWITCH
================================================================ */
function showView(view){
  // HARD RULE: vHome is the central admin/platform homepage (all salons,
  // "Login Amministratore", etc.) — it must never be the page a logged-in
  // owner or barber lands on, no matter which code path called showView().
  // A staff session always belongs on its own salon's dashboard.
  if (view === 'vHome' && SESSION && (SESSION.role === 'owner' || SESSION.role === 'barber')) {
    view = 'vDash';
    if (typeof initDash === 'function') initDash();
  }
  ['vHome','vCustomer','vLogin','vDash'].forEach(v=>$(v).classList.remove('on'));
  $(view).classList.add('on');
  const isDash=view==='vDash';
  const isHome=view==='vHome';
  const isLogin=view==='vLogin';

  // Login screen title reflects whether this is the generic admin-only entry
  // point (no salon context) or a specific salon's staff-access login.
  if (isLogin) {
    const loginTitle = $('loginTitle');
    if (loginTitle) {
      if (!loginSalonContext) loginTitle.textContent = 'Accesso Amministratore';
      else if (loginRoleContext === 'owner') loginTitle.textContent = 'Accesso Proprietario';
      else if (loginRoleContext === 'barber') loginTitle.textContent = 'Accesso Barbiere';
      else loginTitle.textContent = 'Accesso Staff';
    }
    // The marketing content (hero/value cards/footer) only makes sense on
    // the generic root entry point — a staff/owner login reached from a
    // specific salon's page shows just the bare form, like before.
    const showMarketing = !loginSalonContext;
    const marketing = $('vLoginMarketing');
    const footer = $('vLoginFooter');
    if (marketing) marketing.style.display = showMarketing ? '' : 'none';
    if (footer) footer.style.display = showMarketing ? '' : 'none';
    // On the marketing entry point the login form is a modal (opened only
    // via .vlogin-admin-trigger, top-left) — no session-based shortcut, no
    // menu, nobody reaches the salon/dashboard views without an explicit
    // login. A staff/owner login reached from a specific salon's own page
    // keeps rendering the exact same form inline instead, unchanged.
    const overlay = $('vLoginFormOverlay');
    if (overlay) {
      overlay.classList.toggle('as-modal', showMarketing);
      overlay.classList.remove('show');
    }
    if (showMarketing && typeof renderVLoginSalonShowcase === 'function') renderVLoginSalonShowcase();
    if (showMarketing && typeof renderVLoginPhotoGallery === 'function') renderVLoginPhotoGallery();
  }
  // Always re-render the homepage with the current STATE.salons before showing
  // it — otherwise it can show stale content (e.g. a salon added by the admin
  // moments earlier is missing until a full page reload) since navigating
  // here doesn't always go through an explicit renderHomepage() call.
  if(isHome && typeof renderHomepage==='function') renderHomepage();

  // Hide top-left logo inside header on homepage to avoid duplicate logos
  const logoWrap = $('hBrandLogoWrapper');
  if (logoWrap) logoWrap.style.display = isHome ? 'none' : 'flex';


  $('mainBody').classList.toggle('flush',isDash);
  document.querySelector('.head').style.display=isDash?'none':'';
  if(!isDash){closeSide();['modal','workerModal','breakModal','salonModal','userModal'].forEach(closeModal);}
  $('gear').style.display='none';
  updateNavMenu();
  const hBack = $('hBack');
  // Hidden on Homepage (the admin landing page — nothing to go "back" to),
  // on the login screen (its back arrow fell through to browser
  // history.back(), which could land on an unrelated external page), and
  // always on a salon's customer page — a visitor arriving via a QR code/
  // shared link must never be one tap away from the staff login screen
  // (it fell through there whenever there was nothing sensible to go back
  // to, e.g. a leftover staff session on the same phone/browser). The
  // wizard's own "←" button (cBack) already covers stepping back through
  // steps 1-3; staff/admin previewing a salon page use the nav menu's
  // "Vai alla Dashboard" instead.
  if (hBack) hBack.style.display = (isHome || isLogin || view === 'vCustomer') ? 'none' : 'flex';
  
  // Reset window scroll position to the top of the page on view switch
  window.scrollTo(0, 0);

  // Invalidate Leaflet map size on returning to homepage to force redraw
  if (isHome && map) {
    setTimeout(() => { map.invalidateSize(); }, 200);
  }

  if (view === 'vLogin') {
    const toCust = $('toCustomer');
    if (toCust) toCust.style.display = custSalon ? 'block' : 'none';
  }
}

/* ================================================================
   LOGIN — Livelli 1, 2, 3
================================================================ */
let loginSalonContext = null;
// Which role the current vLogin visit is scoped to: null (generic staff
// entry — gear icon / "Sei staff?" — accepts owner OR barber), 'owner'
// (Login Proprietario) or 'barber' (Login Staf/Barbiere). Admin is never
// accepted unless loginSalonContext itself is null (root entry point).
let loginRoleContext = null;

async function onLoginSuccess() {
  clearErr('lErr');
  $('lpw').value = '';
  // Ask for notification permission HERE — still synchronously inside the
  // login button's click (user gesture), but only after credentials checked
  // out, so wrong-password attempts don't trigger a permission prompt.
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(perm => {
      if (perm === 'granted' && typeof initPushNotifications === 'function') {
        initPushNotifications();
      }
    }).catch(()=>{});
  }
  // STATE.bookings up to this point came from the PRE-login sync fetch,
  // which had no session token yet and so got the anonymous/PII-stripped
  // view (name/phone missing on every booking — see scopeBookingsForSession
  // in api/sync.js). Re-fetch now that SESSION.token exists, so the
  // dashboard (and checkNewBookingsOnOpen's "new bookings" toast right
  // below) shows real customer names instead of "undefined".
  if (SESSION && SESSION.token) {
    try {
      const resp = await fetch('/api/sync?t=' + Date.now(), { cache: 'no-store', headers: authHeaders() });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.bookings) STATE.bookings = data.bookings;
        if (data && data.salons && data.salons.length > 0) STATE.salons = data.salons;
      }
    } catch (e) { console.error('Post-login refresh failed:', e); }
  }
  // Admin lands on the public Homepage by default; the header dropdown's
  // "Vai alla Dashboard" option (shown whenever admin is outside the
  // dashboard) is the way in from there, so this is never a dead end.
  if (SESSION && SESSION.role === 'admin') {
    showView('vHome');
  } else {
    showView('vDash');
    initDash();
  }
  if (typeof initPushNotifications === 'function') {
    initPushNotifications();
  }
}

// Server-side credential check (routed through /api/sync — see lib/auth.js)
// — the client never holds plaintext passwords locally anymore, so login
// can't be verified in-browser.
async function tryLogin(payload){
  try {
    const resp = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', ...payload })
    });
    return await resp.json();
  } catch (e) {
    console.error('Login request failed:', e);
    return { success: false, error: 'network_error' };
  }
}

async function doLogin(){
  const usr=$('lusr').value.trim();
  const pwd=$('lpw').value;
  if(!usr||!pwd)return showErr('lErr','Inserisci username e password');

  // The generic entry point (no specific salon context — reached directly
  // from the root URL) only accepts admin credentials. Owner/barber login is
  // only available from their own salon's page (the gear/staff-access button
  // there sets loginSalonContext), never from the bare root login screen —
  // and, symmetrically, admin credentials are never accepted once a salon
  // context is set, even if they happen to match what was typed.
  if (!loginSalonContext) {
    // LIVELLO 1 — Amministratore
    const r = await tryLogin({ role: 'admin', username: usr, password: pwd });
    if (r && (r.error === 'service_unavailable' || r.error === 'network_error')) {
      return showErr('lErr', 'Impossibile contattare il server. Riprova tra poco.');
    }
    if (r && r.success) {
      SESSION={role:'admin',salonId:null,workerId:null,name:'Amministratore',token:r.sessionToken||null};
      saveSession();
      onLoginSuccess();
      return;
    }
    return showErr('lErr', 'Accesso riservato agli amministratori. I proprietari e i barbieri accedono dalla pagina del proprio salone.');
  }

  // LIVELLO 2 — Proprietario salone (only when this screen was reached via
  // "Login Proprietario", or the generic role-agnostic staff entry)
  if (loginRoleContext === 'owner' || loginRoleContext === null) {
    const r = await tryLogin({ role: 'owner', salonId: loginSalonContext, username: usr, password: pwd });
    if (r && r.error === 'salon_inactive') return showErr('lErr', 'Questo salone è inattivo. Accesso negato.');
    if (r && (r.error === 'service_unavailable' || r.error === 'network_error')) {
      return showErr('lErr', 'Impossibile contattare il server. Riprova tra poco.');
    }
    if (r && r.success) {
      SESSION = {role:'owner', salonId:r.salonId, workerId:null, name:'Proprietario · '+r.salonName, token:r.sessionToken||null};
      saveSession();
      onLoginSuccess();
      return;
    }
  }

  // LIVELLO 3 — Barbiere (dipendente) (only when this screen was reached via
  // "Login Staf/Barbiere", or the generic role-agnostic staff entry)
  if (loginRoleContext === 'barber' || loginRoleContext === null) {
    const r = await tryLogin({ role: 'barber', salonId: loginSalonContext, username: usr, password: pwd });
    if (r && r.error === 'salon_inactive') return showErr('lErr', 'Questo salone è inattivo. Accesso negato.');
    if (r && (r.error === 'service_unavailable' || r.error === 'network_error')) {
      return showErr('lErr', 'Impossibile contattare il server. Riprova tra poco.');
    }
    if (r && r.success) {
      SESSION = {role:'barber', salonId:r.salonId, workerId:r.workerId, name:r.name, token:r.sessionToken||null};
      saveSession();
      onLoginSuccess();
      return;
    }
  }

  showErr('lErr','Credenziali non valide');
}

/* ================================================================
   DASHBOARD
================================================================ */
let curSec='oggi',dashDateISO=null,shopOpen=true;
const _now=new Date();
let calYear=_now.getFullYear(),calMonth=_now.getMonth(),calSelISO=todayISO();
let cliYear=_now.getFullYear(),cliMonth=_now.getMonth();
let statsPeriod='oggi',statFrom='',statTo='';
let editSrv=null,editWorker=null;
let lastStatsExport=null;

// Admin navigation (Homepage <-> dashboard sections <-> Nuovo Salone) is
// routed through real URL hashes (#admin/home, #admin/saloni, #admin/stats,
// #admin/nuovo-salone) so that both the browser's own back/forward buttons
// and the in-app back arrows (hBack/dBack) step through the exact path the
// admin actually took, one real page at a time — see handleAdminHashRoute(),
// wired from the hashchange listener and checkInitialHash() in boot().
function adminHashFor(sec) {
  if (sec === 'home') return 'admin/home';
  if (sec === 'newSalon') return 'admin/nuovo-salone';
  return 'admin/' + sec;
}
function handleAdminHashRoute(rawHash) {
  if (!SESSION || SESSION.role !== 'admin') {
    location.hash = '';
    showView('vLogin');
    return;
  }
  const part = rawHash.slice('admin/'.length);
  if (part === 'home') {
    showView('vHome');
  } else if (part === 'nuovo-salone') {
    showView('vDash');
    initDash();
    showSec('saloni');
    openSalonModal('new');
  } else {
    showView('vDash');
    initDash();
    showSec(part);
  }
}

function initDash(){
  const r=SESSION.role;
  const salon=getSalon();

  // HARD RULE: owner/barber dashboards are always scoped to one salon. If the
  // salon can't be resolved (deleted, or session pointing at a stale/foreign
  // id), never render — that would fall back to the generic "TRIMIO · Admin"
  // sidebar and look like the admin page leaked into a salon's staff view.
  // Log out instead of showing an ambiguous dashboard.
  if (r !== 'admin' && !salon) {
    alert(`Il tuo salone non è stato trovato. Effettua nuovamente l'accesso dalla pagina del tuo salone.`);
    doLogout();
    return;
  }

  // sidebar header
  $('sideSalon').textContent=salon?salon.name:'TRIMIO · Admin';
  $('sideSlug').textContent=salon?'#'+salon.slug:'Sistema centrale';
  const rb=$('sideRoleBadge');
  if(r==='admin'){rb.textContent='Amministratore (Liv. 1)';rb.className='side-role-badge role-admin';}
  else if(r==='owner'){rb.textContent='Proprietario (Liv. 2)';rb.className='side-role-badge role-owner';}
  else{rb.textContent='Barbiere (Liv. 3)';rb.className='side-role-badge role-barber';}
  $('sideAv').textContent=initials(SESSION.name);
  $('sideProfName').textContent=SESSION.name;

  const qrBtn=$('sideQrBtn');
  if(qrBtn) qrBtn.style.display=(r==='owner'&&salon)?'block':'none';

  const pwdBtn=$('sidePwdBtn');
  if(pwdBtn) pwdBtn.style.display=(r==='owner'||r==='barber')?'inline-block':'none';

  // build nav per ruolo
  buildNav();

  // date strip (non per admin)
  if(r!=='admin'&&salon){
    buildChips($('oggiDates'),salon,(iso)=>{dashDateISO=iso;renderOggi();});
    const first=$('oggiDates').querySelector('.chip');
    if(first){first.classList.add('sel');dashDateISO=first.dataset.iso;}
  }
  dashDateISO=dashDateISO||todayISO();

  // status badge e pulsante nuovo (livelli 2 e 3)
  $('statusBadge').style.display=r!=='admin'?'inline-block':'none';

  // Load Homepage Ad in Admin form
  if (r === 'admin') {
    const ad = STATE.homepageAd || { title: '', description: '', btnText: '', code: '' };
    $('adTitleInput').value = ad.title || '';
    $('adDescInput').value = ad.description || '';
    $('adBtnInput').value = ad.btnText || '';
    $('adCodeInput').value = ad.code || '';
    if ($('adminNewUser')) $('adminNewUser').value = STATE.admin.username;
    renderHpPhotosList();
  }

  const firstSec=navItems()[0].sec;
  showSec(firstSec);

  renderPushNotifBanner();
  if(r==='barber') checkNewBookingsOnOpen();
}

// Shown once per dashboard entry (login / app reopen) for the barber only —
// summarises whatever bookings were made for them since their last visit,
// so they see it immediately instead of having to notice it passively.
function checkNewBookingsOnOpen(){
  if (!SESSION || SESSION.role !== 'barber' || !SESSION.workerId) return;
  const key = 'trimio_last_check_' + SESSION.workerId;
  let lastCheck = 0;
  try { lastCheck = parseInt(localStorage.getItem(key) || '0', 10) || 0; } catch(e) {}
  const now = Date.now();
  const newOnes = STATE.bookings.filter(b =>
    b.workerId === SESSION.workerId &&
    b.status !== 'cancelled' &&
    !b.isDemo &&
    b.createdAt && new Date(b.createdAt).getTime() > lastCheck
  );
  if (newOnes.length > 0) {
    const label = newOnes.length === 1 ? 'nuova prenotazione' : 'nuove prenotazioni';
    const list = newOnes.slice(0, 5).map(b => `${escapeHtml(b.name)} · ${dayLabel(b.dateISO)} ${b.time}`).join('<br>');
    const extra = newOnes.length > 5 ? `<br>+ altre ${newOnes.length - 5}` : '';
    showToastNotification(`📋 Hai ${newOnes.length} ${label}:<br>${list}${extra}`);
    playNotificationSound();
  }
  try { localStorage.setItem(key, String(now)); } catch(e) {}
}

function navItems(){
  const r=SESSION.role;
  let items = [];
  // LIVELLO 1 — Admin
  if(r==='admin') {
    items = [
      {sec:'saloni',    ic:'🏪',label:'Saloni'},
      {sec:'newSalon',  ic:'➕',label:'Nuovo Salone'},
      {sec:'home',      ic:'🏠',label:'Homepage'},
      {sec:'stats',     ic:'📊',label:'Statistiche'},
      {sec:'utenti',    ic:'🔑',label:'Gestione Utenti'},
    ];
  }
  // LIVELLO 2 — Proprietario
  else if(r==='owner') {
    items = [
      {sec:'oggi',        ic:'📅',label:'Oggi'},
      {sec:'calendario',  ic:'📆',label:'Calendario'},
      {sec:'prossimi',    ic:'🕐',label:'Prossimi'},
      {sec:'clienti',     ic:'👥',label:'Clienti'},
      {sec:'recensioni',  ic:'💬',label:'Recensioni'},
      {sec:'servizi',     ic:'✂️',label:'Servizi'},
      {sec:'stats',       ic:'📊',label:'Statistiche'},
    ];
  }
  // LIVELLO 3 — Barbiere
  else {
    items = [
      {sec:'oggi',       ic:'📅',label:'Oggi'},
      {sec:'calendario', ic:'📆',label:'Calendario'},
      {sec:'prossimi',   ic:'🕐',label:'Prossimi'},
      {sec:'clienti',    ic:'👥',label:'Clienti'},
      {sec:'recensioni',  ic:'💬',label:'Le mie recensioni'},
      {sec:'pause',      ic:'☕',label:'Pause e Ferie'},
      {sec:'stats',      ic:'📊',label:'Statistiche'},
    ];
  }
  // Append Esci as a menu item at the end of the menu for everyone!
  items.push({sec:'logout', ic:'🚪', label:'Esci (Logout)'});
  return items;
}

function buildNav(){
  const nav=$('sideNav');nav.innerHTML='';
  navItems().forEach(it=>{
    const b=document.createElement('button');
    b.className='side-item';b.dataset.sec=it.sec;
    b.innerHTML=`<span class="ic">${it.ic}</span> ${it.label}`;
    b.addEventListener('click',()=>{
      if(it.sec==='logout') {
        doLogout();
      } else if(it.sec==='pause') {
        // Il barbiere imposta da sé pausa pranzo, riposo settimanale e
        // ferie, senza toccare i propri dati anagrafici.
        const s=getSalon();
        if(s && SESSION && SESSION.workerId) openBreakModal(SESSION.workerId, s);
      } else if(it.sec==='home' || it.sec==='newSalon') {
        location.hash = adminHashFor(it.sec);
      } else if (SESSION && SESSION.role === 'admin') {
        location.hash = adminHashFor(it.sec);
      } else {
        showSec(it.sec);
      }
      closeSide();
    });
    nav.appendChild(b);
  });
}

function showSec(sec){
  curSec=sec;
  ['secOggi','secCalendario','secProssimi','secClienti','secServizi','secDipendenti','secStats','secSaloni','secUtenti','secRecensioni']
    .forEach(id=>$(id).classList.remove('on'));
  const map={oggi:'secOggi',calendario:'secCalendario',prossimi:'secProssimi',clienti:'secClienti',
    servizi:'secServizi',dipendenti:'secDipendenti',stats:'secStats',saloni:'secSaloni',utenti:'secUtenti',recensioni:'secRecensioni'};
  const titles={oggi:'Oggi',calendario:'Calendario',prossimi:'Prossimi',clienti:'Clienti',
    servizi:'Servizi & prezzi',dipendenti:'Dipendenti',stats:'Statistiche',saloni:'Saloni',utenti:'Utenti',recensioni:'Recensioni Ricevute'};
  if(map[sec])$(map[sec]).classList.add('on');
  $('sideNav').querySelectorAll('.side-item').forEach(b=>b.classList.toggle('active',b.dataset.sec===sec));
  $('dTitle').textContent=titles[sec]||sec;
  $('statusBadge').style.display=(sec==='oggi'&&SESSION.role!=='admin')?'inline-block':'none';
  $('newBtn').style.display=(sec==='oggi'&&SESSION.role!=='admin')?'inline-block':'none';
  renderDash();
}

function renderDashboardReviews() {
  const salon=getSalon();if(!salon)return;
  const r=SESSION.role;
  let html='';
  
  let workersToRender = salon.workers || [];
  if(r==='barber') {
    workersToRender = workersToRender.filter(w=>w.id===SESSION.workerId);
  }
  
  let allReviews = [];
  workersToRender.forEach(w => {
    const reviews = w.reviews || [];
    reviews.forEach(rev => {
      allReviews.push({
        workerName: w.name,
        workerId: w.id,
        ...rev
      });
    });
  });
  
  // Sort by date desc
  allReviews.sort((a,b)=>(b.date || '').localeCompare(a.date || ''));
  
  if(allReviews.length === 0){
    $('recensioniList').innerHTML=`<div class="empty"><div class="empty-ic">💬</div><div class="empty-t">Nessuna recensione presente</div></div>`;
    return;
  }
  
  html = allReviews.map(rev => {
    const workerLabel = r === 'owner' ? `<span style="font-size:11px; color:#4f46e5; font-weight:700; margin-left:8px; background:#eef2ff; padding:2px 8px; border-radius:10px;">per ${escapeHtml(rev.workerName)}</span>` : '';
    return `
      <div class="srv" style="padding:14px; margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <div>
            <strong style="font-size:14px; color:#111;">${escapeHtml(rev.author)}</strong>
            ${workerLabel}
          </div>
          <span style="color:#e5c158; font-weight:700; font-size:12px;">${'★'.repeat(rev.rating)}${'☆'.repeat(5-rev.rating)}</span>
        </div>
        <div style="font-size:13px; color:#444; font-style:italic; line-height:1.4; margin-bottom:6px; padding-left:4px; border-left:2px solid #e5c158;">"${escapeHtml(rev.comment)}"</div>
        <div style="font-size:10px; color:#999; text-align:right;">${rev.date || '—'}</div>
      </div>
    `;
  }).join('');
  
  $('recensioniList').innerHTML = html;
}

function renderDash(){
  renderNewBookingsPanel();
  if(curSec==='oggi')renderOggi();
  else if(curSec==='calendario')renderCalendar();
  else if(curSec==='prossimi')renderProssimi();
  else if(curSec==='clienti')renderClienti();
  else if(curSec==='recensioni')renderDashboardReviews();
  else if(curSec==='servizi')renderServizi();
  else if(curSec==='dipendenti')renderDipendenti();
  else if(curSec==='stats')renderStats();
  else if(curSec==='saloni')renderSaloni();
  else if(curSec==='utenti')renderUtenti();
}

/* ---- OGGI ---- */
/* Livello 2 (owner): vede TUTTI i barbieri del salone
   Livello 3 (barber): vede SOLO le sue prenotazioni */
function renderOggi(){
  const salon=getSalon();if(!salon)return;
  const iso=dashDateISO;
  let bks=STATE.bookings.filter(b=>b.salonId===salon.id&&b.dateISO===iso&&b.status!=='cancelled');
  if(SESSION.role==='barber')bks=bks.filter(b=>b.workerId===SESSION.workerId);
  bks.sort((a,b)=>a.time.localeCompare(b.time));
  const wait=bks.filter(b=>b.status!=='completed');
  const served=bks.filter(b=>b.status==='completed');
  $('kIncasso').textContent='€'+bks.reduce((s,b)=>s+(b.price||0),0);
  $('kAppt').textContent=bks.length;
  $('kWait').textContent=wait.length;
  if($('kIncassoServito'))$('kIncassoServito').textContent='€'+served.reduce((s,b)=>s+(b.price||0),0);
  if($('kApptServiti'))$('kApptServiti').textContent=served.length;

  // LIVELLO 2: banner con stato real-time
  if(SESSION.role==='owner'){
    const tiso=todayISO();
    const todayBks=STATE.bookings.filter(b=>b.salonId===salon.id&&b.dateISO===tiso&&b.status!=='cancelled');
    const nowServing=todayBks.filter(b=>b.status==='completed');
    const tmDate=new Date();tmDate.setDate(tmDate.getDate()+1);
    const offset = tmDate.getTimezoneOffset();
    const localTm = new Date(tmDate.getTime() - (offset * 60 * 1000));
    const tmISO = localTm.toISOString().split('T')[0];
    const tmBks=STATE.bookings.filter(b=>b.salonId===salon.id&&b.dateISO===tmISO&&b.status!=='cancelled');

    const busyW=salon.workers.filter(w=>nowServing.some(b=>b.workerId===w.id));
    const freeW=salon.workers.filter(w=>!nowServing.some(b=>b.workerId===w.id));

    const perW=(bkArr)=>salon.workers.map(w=>`${w.name}: ${bkArr.filter(b=>b.workerId===w.id).length}`).join(' · ');

    let html=`<div class="notif-label">Stato salone</div>`;
    if(busyW.length)html+=`<div class="notif-line">🔵 In servizio: <span class="nb-busy">${busyW.map(w=>w.name).join(', ')}</span></div>`;
    if(freeW.length)html+=`<div class="notif-line">🟢 Liberi: <span class="nb-free">${freeW.map(w=>w.name).join(', ')}</span></div>`;
    html+=`<div class="notif-line" style="margin-top:8px">📅 Oggi: <b>${todayBks.length}</b> prenotazioni — ${perW(todayBks)}</div>`;
    html+=`<div class="notif-line">📅 Domani: <b>${tmBks.length}</b> prenotazioni — ${perW(tmBks)}</div>`;
    $('notifBanner').innerHTML=html;$('notifBanner').style.display='block';
  } else {
    $('notifBanner').style.display='none';
  }

  const chip=[...$('oggiDates').querySelectorAll('.chip')].find(c=>c.dataset.iso===iso);
  $('oggiHdr').textContent=chip?'Appuntamenti · '+chip.dataset.label:'Appuntamenti';
  if(bks.length===0){$('oggiList').innerHTML=`<div class="empty"><div class="empty-ic">📭</div><div class="empty-t">Nessun appuntamento</div></div>`;return;}
  $('oggiList').innerHTML=bks.map(b=>apptCard(b,true)).join('');
  wireActs($('oggiList'));
}

/* LIVELLO 2: vede il barbiere nella card; LIVELLO 3: non lo vede */
function apptCard(b,showActs){
  const endTime=bookingEndTime(getSalonById(b.salonId),b.service,b.time);
  // "Fatto" (mark service as completed/arrived): barber + admin.
  // "Annulla" (cancel): barber + owner. Admin does not cancel bookings.
  const canMarkDone = showActs && SESSION && (SESSION.role === 'admin' || SESSION.role === 'barber');
  const canCancel = showActs && SESSION && (SESSION.role === 'barber' || SESSION.role === 'owner');
  // Manual "notify client" (barber only) — on top of the automatic 24h-before
  // reminder, lets the barber ping the client immediately if they opted in.
  const canNotify = showActs && SESSION && SESSION.role === 'barber';
  const acts=(b.status==='confirmed'&&(canMarkDone||canCancel||canNotify))?`<div class="acard-acts">
    ${canMarkDone?`<button class="act done" data-act="done" data-id="${b.id}">✓ Fatto</button>`:''}
    ${canCancel?`<button class="act" data-act="cancel" data-id="${b.id}">Annulla</button>`:''}
    ${canNotify?`<button class="act" data-act="notify" data-id="${b.id}">🔔 Notifica</button>`:''}</div>`:'';
  const src=b.source==='online'?`<span class="tag-src">Online</span>`:'';
  const barberRow=SESSION.role!=='barber'?`<div class="acard-barber">✂️ ${escapeHtml(b.workerName)||'—'}</div>`:'';
  const phoneRow = b.phone ? `<div class="acard-phone" style="font-size:13px; font-weight:600; color:#18181b; margin-top:2px;">📞 ${escapeHtml(b.phone)}</div>` : (SESSION && SESSION.role==='barber' ? `<div class="acard-phone" style="font-size:12px; color:#bbb; margin-top:2px;">📞 Nessun numero</div>` : '');
  return`<div class="acard ${b.status==='completed'?'completed':b.status==='cancelled'?'cancelled':''}">
    <div class="acard-main">
      <div class="av">${escapeHtml(initials(b.name))}</div>
      <div class="acard-info">
        <div class="acard-name">${escapeHtml(b.name)||'Cliente'}${src}</div>
        <div class="acard-svc">${escapeHtml(b.service)}</div>${phoneRow}${barberRow}
      </div>
      <div class="acard-right"><div class="acard-time">${endTime?`${b.time}-${endTime}`:b.time}</div><div class="acard-price">€${b.price}</div></div>
    </div>${acts}</div>`;
}
function wireActs(c){c.querySelectorAll('.act').forEach(b=>b.addEventListener('click',(e)=>{
  if(b.dataset.act==='notify'){notifyCustomerNow(b.dataset.id,b);return;}
  dashAction(b.dataset.act,b.dataset.id);
}));}
// "Fatto" only makes sense once the appointment has actually started — a
// barber marking a future slot as done would let it silently disappear from
// "da fare" lists before the client even showed up.
function isBookingInFuture(b){
  const today=todayISO();
  if(b.dateISO>today)return true;
  if(b.dateISO<today)return false;
  const now=new Date();
  const nowStr=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  return b.time>nowStr;
}
async function dashAction(act,id){
  const b=STATE.bookings.find(x=>x.id===id);if(!b)return;
  if(act==='done'&&isBookingInFuture(b)){
    alert(`Non puoi segnare come "Fatto" un appuntamento futuro (${b.dateLabel} alle ${b.time}). Attendi che arrivi l'orario dell'appuntamento.`);
    return;
  }
  b.status=act==='done'?'completed':'cancelled';
  if(act==='cancel')b.cancelledBy='staff';
  await saveState();renderDash();renderNewBookingsPanel();
}

// Manual "notify client" button — sends an immediate push reminder for one
// specific booking, if that client opted in on their confirmation screen.
async function notifyCustomerNow(bookingId, btn){
  const original=btn.textContent;
  btn.textContent='…';btn.disabled=true;
  try{
    const resp=await fetch('/api/notify-customer',{
      method:'POST',
      headers:{'Content-Type':'application/json', ...authHeaders()},
      body:JSON.stringify({bookingId})
    });
    const data=await resp.json().catch(()=>({}));
    if(data.success){
      btn.textContent='✓ Inviato';
      setTimeout(()=>{btn.textContent=original;btn.disabled=false;},2500);
    }else if(data.reason==='no_subscription'){
      btn.textContent='Cliente non iscritto';
      setTimeout(()=>{btn.textContent=original;btn.disabled=false;},2500);
      alert('Questo cliente non ha attivato le notifiche sul suo dispositivo.\n\nLe notifiche possono essere attivate SOLO dal cliente stesso: dopo aver completato la prenotazione, deve toccare "Attiva" nel banner "Vuoi ricevere un promemoria 24h prima?" e accettare il permesso di notifica (su iPhone serve prima aggiungere TRIMIO alla schermata Home).\n\nSenza questa attivazione non è possibile inviargli notifiche — né manuali né il promemoria automatico 24h prima.');
    }else{
      btn.textContent='Errore invio';
      setTimeout(()=>{btn.textContent=original;btn.disabled=false;},2500);
    }
  }catch(e){
    btn.textContent='Errore invio';
    setTimeout(()=>{btn.textContent=original;btn.disabled=false;},2500);
  }
}

/* ---- NEW BOOKINGS INBOX PANEL ---- */
function renderNewBookingsPanel(){
  const panel = $('newBookingsPanel');
  if (panel) panel.style.display = 'none';
  return; // Keep hidden completely as owner/staff have no right of confirmation/cancellation
}

/* ---- PROSSIMI ---- */
/* Livello 3: solo i suoi; Livello 2: tutti */
function renderProssimi(){
  const salon=getSalon();if(!salon)return;
  const tiso=todayISO();
  let fut=STATE.bookings.filter(b=>b.salonId===salon.id&&b.status==='confirmed'&&b.dateISO>tiso);
  if(SESSION.role==='barber')fut=fut.filter(b=>b.workerId===SESSION.workerId);
  fut.sort((a,b)=>a.dateISO===b.dateISO?a.time.localeCompare(b.time):a.dateISO.localeCompare(b.dateISO));
  if(!fut.length){$('prossimiList').innerHTML=`<div class="empty"><div class="empty-ic">🗓️</div><div class="empty-t">Nessun appuntamento futuro</div></div>`;return;}
  
  const displayedFut = fut.slice(0, 150);
  let html='',lastDay=null;
  displayedFut.forEach(b=>{if(b.dateISO!==lastDay){html+=`<div class="day-h">${dayLabel(b.dateISO)}</div>`;lastDay=b.dateISO;}html+=apptCard(b,true);});
  
  if(fut.length > 150){
    html+=`<div style="text-align:center; padding:15px; color:#888; font-size:12px;">Mostrati i primi 150 appuntamenti di ${fut.length} totali. Usa il Calendario per date specifiche.</div>`;
  }
  $('prossimiList').innerHTML=html;wireActs($('prossimiList'));
}

/* ---- CALENDARIO ---- */
function renderCalendar(){
  const salon=getSalon();if(!salon)return;
  const dim=new Date(calYear,calMonth+1,0).getDate();
  const off=(new Date(calYear,calMonth,1).getDay()+6)%7;
  const counts={};
  let bks=STATE.bookings.filter(b=>b.salonId===salon.id&&b.status!=='cancelled');
  if(SESSION.role==='barber')bks=bks.filter(b=>b.workerId===SESSION.workerId);
  bks.forEach(b=>{counts[b.dateISO]=(counts[b.dateISO]||0)+1;});
  const tiso=todayISO();let cells='';
  for(let i=0;i<off;i++)cells+='<div class="cal-cell empty"></div>';
  for(let d=1;d<=dim;d++){
    const iso=isoOf(calYear,calMonth,d);
    const closed=(salon.closedDays||[]).includes(new Date(calYear,calMonth,d).getDay());
    const n=counts[iso]||0;
    let cls='cal-cell';if(iso===tiso)cls+=' today';if(iso===calSelISO)cls+=' sel';if(closed)cls+=' closed';
    cells+=`<div class="${cls}" data-iso="${iso}"><span class="cal-n">${d}</span>${n?`<span class="cal-dot">${n}</span>`:''}</div>`;
  }
  $('calGrid').innerHTML=cells;
  $('calTitle').textContent=`${MF[calMonth]} ${calYear}`;
  $('calGrid').querySelectorAll('.cal-cell[data-iso]').forEach(c=>c.addEventListener('click',()=>{calSelISO=c.dataset.iso;renderCalendar();}));
  renderCalDay(salon);
}
function renderCalDay(salon){
  const sel=new Date(calSelISO+'T00:00:00');
  if(sel.getMonth()!==calMonth||sel.getFullYear()!==calYear){
    $('calDayH').textContent='Seleziona un giorno';
    $('calDayList').innerHTML=`<div class="empty" style="padding:20px"><div class="empty-t">Tocca un giorno per vedere gli appuntamenti</div></div>`;return;
  }
  let items=STATE.bookings.filter(b=>b.salonId===salon.id&&b.dateISO===calSelISO&&b.status!=='cancelled');
  if(SESSION.role==='barber')items=items.filter(b=>b.workerId===SESSION.workerId);
  items.sort((a,b)=>a.time.localeCompare(b.time));
  $('calDayH').textContent=dayLabel(calSelISO);
  if(!items.length){$('calDayList').innerHTML=`<div class="empty" style="padding:26px 20px"><div class="empty-t">Nessun appuntamento</div></div>`;return;}
  $('calDayList').innerHTML=items.map(b=>apptCard(b,true)).join('');wireActs($('calDayList'));
}
function calShift(d){calMonth+=d;if(calMonth<0){calMonth=11;calYear--;}if(calMonth>11){calMonth=0;calYear++;}renderCalendar();}

/* ---- CLIENTI ---- */
/* Livello 3: solo i suoi; Livello 2: tutti */
function cliShift(d){cliMonth+=d;if(cliMonth<0){cliMonth=11;cliYear--;}if(cliMonth>11){cliMonth=0;cliYear++;}renderClienti();}
function renderClienti(){
  const salon=getSalon();if(!salon)return;
  const mk=`${cliYear}-${String(cliMonth+1).padStart(2,'0')}`;
  $('cliMonthLabel').textContent=`${MF[cliMonth]} ${cliYear}`;
  let bks=STATE.bookings.filter(b=>b.salonId===salon.id&&b.status!=='cancelled');
  if(SESSION.role==='barber')bks=bks.filter(b=>b.workerId===SESSION.workerId);
  const map={};
  bks.forEach(b=>{
    const k=(b.name||'Cliente').trim().toLowerCase();
    if(!map[k])map[k]={name:b.name||'Cliente',visits:0,spent:0,last:'',month:0};
    const c=map[k];c.visits++;c.spent+=(b.price||0);
    if(b.dateISO>c.last)c.last=b.dateISO;
    if((b.dateISO||'').slice(0,7)===mk)c.month++;
  });
  const list=Object.values(map).sort((a,b)=>b.month-a.month||b.visits-a.visits);
  if(!list.length){$('clientiList').innerHTML=`<div class="empty"><div class="empty-ic">👥</div><div class="empty-t">Ancora nessun cliente</div></div>`;return;}
  const fedeli=list.filter(c=>c.month>=2).length;
  const totRev=list.reduce((s,c)=>s+(c.spent||0),0);
  let html=`<div class="cli-summary"><div><b>${list.length}</b>clienti totali</div><div><b>${fedeli}</b>fedeli in ${MON[cliMonth]}</div><div class="cli-sum-rev"><b>€${totRev}</b>incasso</div></div>`;
  html+=list.map(c=>{const f=freqTag(c.month);return`<div class="cli">
    <div class="av">${escapeHtml(initials(c.name))}</div>
    <div class="cli-info"><div class="cli-name">${escapeHtml(c.name)} <span class="freq ${f.c}">${f.l}</span></div>
    <div class="cli-sub">Ultima: ${relDay(c.last)} · ${MON[cliMonth]}: ${c.month} volte</div></div>
    <div class="cli-stat"><div class="cli-spent">${c.visits} volte</div><div class="cli-visits">€${c.spent}</div></div>
  </div>`;}).join('');
  $('clientiList').innerHTML=html;
}

/* ---- SERVIZI ----
   Livello 1 (admin): modifica i servizi di TUTTI i saloni (mostra selector salone)
   Livello 2 (owner): modifica solo i servizi del suo salone
   Livello 3 (barber): NON ha questa sezione nel menu */
let editSrvSalonId=null;
function renderServizi(){
  const r=SESSION.role;
  let targetSalon=getSalon();
  if(r==='admin'){
    // admin: selector salone in cima
    if(!editSrvSalonId&&STATE.salons.length>0)editSrvSalonId=STATE.salons[0].id;
    targetSalon=getSalonById(editSrvSalonId);
    // build salon selector
    let selHtml=`<div class="barber-filter" style="margin-bottom:16px">`;
    STATE.salons.forEach(s=>{selHtml+=`<button class="bf-btn${s.id===editSrvSalonId?' active':''}" data-sid="${s.id}">${s.name}</button>`;});
    selHtml+=`</div>`;
    $('serviziList').innerHTML=selHtml;
    $('serviziList').querySelectorAll('[data-sid]').forEach(b=>b.addEventListener('click',()=>{editSrvSalonId=b.dataset.sid;editSrv=null;renderServizi();}));
  }
  if(!targetSalon){$('serviziList').innerHTML+='<div class="empty"><div class="empty-t">Nessun salone</div></div>';return;}
  const svcs=targetSalon.services||[];
  const canEdit=r==='admin'||r==='owner';
  let html=r==='admin'?$('serviziList').innerHTML:'';
  svcs.forEach(s=>{
    if(editSrv===s.id){
      html+=`<div class="srv"><div class="srv-edit">
        <input id="esName" value="${s.name.replace(/"/g,'&quot;')}" placeholder="Nome servizio">
        <div class="row2"><input id="esMin" type="number" value="${parseInt(s.dur)||30}" placeholder="Min"><input id="esPrice" type="number" value="${s.price}" placeholder="€"></div>
        <div class="srv-save"><button class="b-cancel" data-x="cancel">Annulla</button><button class="b-save" data-x="save" data-id="${s.id}">Salva</button></div>
      </div></div>`;
    } else {
      html+=`<div class="srv"><div class="srv-row">
        <div class="srv-info"><div class="srv-nm">${s.name}</div><div class="srv-du">${s.dur}</div></div>
        <div class="srv-pr">€${s.price}</div>
        ${canEdit?`<div class="srv-btns"><button class="iconbtn" data-edit="${s.id}">✏️</button><button class="iconbtn del" data-del="${s.id}">🗑️</button></div>`:''}
      </div></div>`;
    }
  });
  if(editSrv==='new'){
    html+=`<div class="srv"><div class="srv-edit">
      <input id="esName" value="" placeholder="Nome servizio">
      <div class="row2"><input id="esMin" type="number" value="30" placeholder="Min"><input id="esPrice" type="number" value="" placeholder="€"></div>
      <div class="srv-save"><button class="b-cancel" data-x="cancel">Annulla</button><button class="b-save" data-x="save" data-id="new">Salva</button></div>
    </div></div>`;
  }
  if(r==='admin')$('serviziList').innerHTML=html;
  else $('serviziList').innerHTML=html;
  $('addSrvBtn').style.display=(canEdit&&!editSrv)?'block':'none';
  $('serviziList').querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>{editSrv=b.dataset.edit;renderServizi();}));
  $('serviziList').querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm('Eliminare?'))return;
    targetSalon.services=targetSalon.services.filter(x=>x.id!==b.dataset.del);
    await saveState();renderServizi();
  }));
  $('serviziList').querySelectorAll('[data-x]').forEach(b=>b.addEventListener('click',async()=>{
    if(b.dataset.x==='cancel'){editSrv=null;renderServizi();return;}
    const name=$('esName').value.trim(),min=parseInt($('esMin').value)||0,price=parseInt($('esPrice').value)||0;
    if(name.length<2||price<=0){alert('Inserisci nome e prezzo validi');return;}
    if(b.dataset.id==='new')targetSalon.services.push({id:'sv'+Date.now(),name,dur:min+' min',price});
    else{const s=targetSalon.services.find(x=>x.id===b.dataset.id);if(s){s.name=name;s.dur=min+' min';s.price=price;}}
    editSrv=null;await saveState();renderServizi();
  }));
}

/* ---- DIPENDENTI ----
   Livello 1 (admin): aggiunge/rimuove dipendenti su richiesta del proprietario, scegliendo il salone
   Livello 2 (owner): gestisce i propri dipendenti, ferie, password */
let dipSalonId=null;
function renderDipendenti(){
  const r=SESSION.role;
  let targetSalon=getSalon();

  if(r==='admin'){
    if(!dipSalonId&&STATE.salons.length>0)dipSalonId=STATE.salons[0].id;
    targetSalon=getSalonById(dipSalonId);
    let selHtml=`<div class="barber-filter">`;
    STATE.salons.forEach(s=>{selHtml+=`<button class="bf-btn${s.id===dipSalonId?' active':''}" data-dipsid="${s.id}">${s.name}</button>`;});
    selHtml+=`</div>`;
    $('dipendentiList').innerHTML=selHtml;
    $('dipendentiList').querySelectorAll('[data-dipsid]').forEach(b=>b.addEventListener('click',()=>{dipSalonId=b.dataset.dipsid;renderDipendenti();}));
  }
  if(!targetSalon){$('dipendentiList').innerHTML+='<div class="empty"><div class="empty-t">Nessun salone</div></div>';$('addWorkerBtn').style.display='none';return;}

  const canEdit=r==='admin'||r==='owner';
  let html=r==='admin'?$('dipendentiList').innerHTML:'';
  targetSalon.workers.forEach(w=>{
    const vacLabel=w.vacFrom&&w.vacTo?`<span class="vac-tag">Ferie ${w.vacFrom} → ${w.vacTo}</span>`:'';
    const showDel = r==='admin'; // Only admin can delete staff
    const showBreak = r==='admin'||r==='owner'; // Pause e riposo: gestibili da admin e proprietario (o dal barbiere stesso dal proprio menu)
    html+=`<div class="worker-card${w.vacFrom?' on-vac':''}">
      <div class="av">${initials(w.name)}</div>
      <div class="wc-info"><div class="wc-name">${w.name}${vacLabel}</div><div class="wc-meta">@${w.username}</div></div>
      ${canEdit?`<div class="wc-btns"><button class="iconbtn" data-wedit="${w.id}">✏️</button>${showBreak?`<button class="iconbtn" title="Pause e riposo" data-wbreak="${w.id}">🕐</button>`:''}${showDel?`<button class="iconbtn del" data-wdel="${w.id}">🗑️</button>`:''}</div>`:''}
    </div>`;
  });
  if(!targetSalon.workers.length)html+=`<div class="empty" style="padding:30px 0"><div class="empty-t">Nessun dipendente</div></div>`;
  $('dipendentiList').innerHTML=html;
  $('addWorkerBtn').style.display=r==='admin'?'block':'none'; // Only admin can add staff
  $('dipendentiList').querySelectorAll('[data-wedit]').forEach(b=>b.addEventListener('click',()=>openWorkerModal(b.dataset.wedit,targetSalon)));
  $('dipendentiList').querySelectorAll('[data-wbreak]').forEach(b=>b.addEventListener('click',()=>openBreakModal(b.dataset.wbreak,targetSalon)));
  $('dipendentiList').querySelectorAll('[data-wdel]').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm('Eliminare questo dipendente?'))return;
    targetSalon.workers=targetSalon.workers.filter(x=>x.id!==b.dataset.wdel);
    await saveState();renderDipendenti();
  }));
}

let workerEditSalonId=null;
// Riempie un selettore di giorni di riposo settimanale (usato nel modal Pause).
function setOffDaysUI(boxId,offDays,disabled){
  const set=new Set((offDays||[]).map(Number));
  const box=$(boxId);if(!box)return;
  box.innerHTML=OFFDAY_DEFS.map(([v,l])=>
    `<label class="offday-chip${set.has(v)?' on':''}"><input type="checkbox" value="${v}"${set.has(v)?' checked':''}${disabled?' disabled':''}>${l}</label>`
  ).join('');
  box.querySelectorAll('input').forEach(inp=>inp.addEventListener('change',()=>{
    inp.closest('.offday-chip').classList.toggle('on',inp.checked);
  }));
}
function getOffDaysUI(boxId){
  const box=$(boxId);if(!box)return[];
  return[...box.querySelectorAll('input:checked')].map(i=>Number(i.value));
}
function openWorkerModal(wid,salon){
  // Store the salon's id, not the object itself: a background sync poll can
  // replace STATE.salons with a brand-new array/objects while this modal
  // sits open (uploading a photo, typing a phone number...), which would
  // orphan a held object reference — saveWorker()/deleting a worker would
  // then silently mutate a detached copy that never reaches STATE.salons.
  workerEditSalonId=salon.id;clearErr('wErr');
  const isOwner = SESSION.role === 'owner';
  ['wName','wUser','wPwd','wImg','wImgFile','wPhone','wRole','wDesc'].forEach(id=>{ $(id).disabled = isOwner; });
  $('wImgStatus').textContent='';
  if(wid==='new'){
    $('workerModalH').textContent='Nuovo dipendente';
    ['wName','wUser','wPwd','wImg','wPhone','wRole','wDesc','wVacFrom','wVacTo'].forEach(id=>$(id).value='');
    $('wImgPreview').style.display='none';
    $('wDelete').style.display='none';editWorker='new';
  } else {
    const w=salon.workers.find(x=>x.id===wid);if(!w)return;
    $('workerModalH').textContent='Modifica · '+w.name;
    $('wName').value=w.name;$('wUser').value=w.username;$('wPwd').value='';
    $('wImg').value=w.img||'';$('wPhone').value=w.phone||'';
    $('wRole').value=w.role||'';$('wDesc').value=w.desc||'';
    if(w.img){$('wImgPreview').src=w.img;$('wImgPreview').style.display='block';}
    else{$('wImgPreview').style.display='none';}
    $('wVacFrom').value=w.vacFrom||'';$('wVacTo').value=w.vacTo||'';
    // Hide delete button inside modal for owners
    $('wDelete').style.display=isOwner?'none':'block';
    editWorker=wid;
  }
  $('workerModal').classList.add('show');
}
async function saveWorker(){
  const salon=STATE.salons.find(x=>x.id===workerEditSalonId);if(!salon)return;
  const vacFrom=$('wVacFrom').value,vacTo=$('wVacTo').value;
  // Owner only updates vacation dates (no access to the rest of the barber's
  // data). Lunch break + weekly rest live in the separate "Pause" modal.
  if (SESSION.role === 'owner') {
    const w=salon.workers.find(x=>x.id===editWorker);
    if(w) {
      w.vacFrom=vacFrom;
      w.vacTo=vacTo;
    }
  } else {
    const name=$('wName').value.trim(),usr=$('wUser').value.trim(),pwd=$('wPwd').value.trim();
    const img=$('wImg').value.trim(),phone=$('wPhone').value.trim();
    const role=$('wRole').value.trim(),desc=$('wDesc').value.trim();
    if(name.length<2)return showErr('wErr','Inserisci il nome');
    if(!usr)return showErr('wErr','Inserisci username');
    if(!phone)return showErr('wErr','Il numero di telefono è obbligatorio');
    if(!isValidItalianPhone(phone))return showErr('wErr','Inserisci un numero di telefono italiano valido (es. +39 333 123 4567)');
    if(editWorker==='new'){
      if(!pwd)return showErr('wErr','Password obbligatoria per nuovo dipendente');
      salon.workers.push({id:'w'+Date.now(),name,username:usr,password:pwd,img,phone,role,desc,vacFrom,vacTo,reviews:[]});
    } else {
      const w=salon.workers.find(x=>x.id===editWorker);if(!w)return;
      w.name=name;w.username=usr;
      w.img=img;w.phone=phone;w.role=role;w.desc=desc;w.vacFrom=vacFrom;w.vacTo=vacTo;
      // Password lives only server-side now — a change here must go through
      // the verified admin_set endpoint, never through the generic bulk save.
      if (pwd) {
        const r = await adminSetPassword({ targetType: 'barber', salonId: salon.id, workerId: w.id, newPassword: pwd });
        if (!r || !r.success) return; // adminSetPassword already alerted the reason
      }
    }
  }

  await saveState();
  closeModal('workerModal');
  renderDipendenti();
  
  // Re-render worker list inside salonModal if it is open
  if (salonEditId && salonEditId !== 'new') {
    const s = STATE.salons.find(x => x.id === salonEditId);
    if (s) renderSalonModalWorkers(s);
  }
}

/* ================================================================
   PAUSE, RIPOSO E FERIE — modal separato dai dati anagrafici del barbiere.
   Vi accedono il barbiere stesso (per sé, incluse le proprie ferie) e
   l'admin (per ogni barbiere); contiene la pausa pranzo, il riposo
   settimanale e le date di ferie.
================================================================ */
let breakEditSalonId=null,breakEditWorkerId=null;
// Riempie una <select> con orari in formato 24h (ogni 15 min, 08:00–21:00):
// un <input type="time"> mostra AM/PM in alcuni dispositivi e "12:00" veniva
// salvato come 00:00 (mezzanotte). La select con etichette 24h è inequivocabile.
function fillBreakTimeSelect(id,val){
  const el=$(id);if(!el)return;
  let html='<option value="">—</option>';
  for(let m=8*60;m<=21*60;m+=15){const t=minToTime(m);html+=`<option value="${t}">${t}</option>`;}
  el.innerHTML=html;
  el.value=val||'';
}
function openBreakModal(wid,salon){
  if(!salon)return;
  breakEditSalonId=salon.id;breakEditWorkerId=wid;
  const w=salon.workers.find(x=>x.id===wid);if(!w)return;
  clearErr('bkErr');
  $('breakModalH').textContent='Pause, Riposo e Ferie · '+(w.name||'').split(' ')[0];
  fillBreakTimeSelect('bkBreakFrom',w.breakFrom);
  fillBreakTimeSelect('bkBreakTo',w.breakTo);
  setOffDaysUI('bkOffDays',w.offDays,false);
  $('bkVacFrom').value=w.vacFrom||'';
  $('bkVacTo').value=w.vacTo||'';
  $('breakModal').classList.add('show');
}
async function saveBreak(){
  const salon=STATE.salons.find(x=>x.id===breakEditSalonId);if(!salon)return;
  const w=salon.workers.find(x=>x.id===breakEditWorkerId);if(!w)return;
  const from=$('bkBreakFrom').value,to=$('bkBreakTo').value;
  // Pausa pranzo: o entrambi vuoti (nessuna pausa) o un intervallo valido.
  if((from&&!to)||(!from&&to))return showErr('bkErr','Inserisci sia inizio che fine della pausa pranzo');
  if(from&&to){
    const a=timeToMin(from),b=timeToMin(to);
    if(a===null||b===null)return showErr('bkErr','Orario pausa non valido');
    if(b<=a)return showErr('bkErr','La fine della pausa deve essere dopo l\'inizio');
  }
  const vacFrom=$('bkVacFrom').value,vacTo=$('bkVacTo').value;
  // Ferie: o entrambe vuote (nessuna ferie) o un intervallo valido.
  if((vacFrom&&!vacTo)||(!vacFrom&&vacTo))return showErr('bkErr','Inserisci sia la data di inizio che di fine ferie');
  if(vacFrom&&vacTo&&vacTo<vacFrom)return showErr('bkErr','La fine delle ferie deve essere dopo l\'inizio');
  w.breakFrom=from;w.breakTo=to;
  w.offDays=getOffDaysUI('bkOffDays');
  w.vacFrom=vacFrom;w.vacTo=vacTo;
  await saveState();
  closeModal('breakModal');
  // L'admin vede la lista dipendenti: aggiornala (il barbiere non ce l'ha).
  if(SESSION.role==='admin'||SESSION.role==='owner')renderDipendenti();
  // Il barbiere vede subito le proprie ferie riflesse in "Oggi"/Calendario.
  if(SESSION.role==='barber')renderDash();
}

/* ---- STATISTICHE ----
   Livello 1 (admin): statistiche di tutti i saloni
   Livello 2 (owner): statistiche del salone (per barbiere, per servizio, per periodo)
   Livello 3 (barber): statistiche personali (clienti e euro per giorno/periodo) */
function filterByPeriod(bks){
  const now=new Date();const tiso=todayISO();
  if(statsPeriod==='oggi')return bks.filter(b=>b.dateISO===tiso);
  if(statsPeriod==='settimana'){
    const d=new Date();d.setDate(d.getDate()-7);
    const iso = isoOf(d.getFullYear(), d.getMonth(), d.getDate());
    return bks.filter(b=>b.dateISO>=iso);
  }
  if(statsPeriod==='mese'){const k=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;return bks.filter(b=>b.dateISO>=k);}
  if(statsPeriod==='anno')return bks.filter(b=>b.dateISO>=(now.getFullYear()+'-01-01'));
  if(statsPeriod==='custom'&&statFrom&&statTo)return bks.filter(b=>b.dateISO>=statFrom&&b.dateISO<=statTo);
  return bks;
}
function periodLabel(){
  if(statsPeriod==='oggi')return 'Oggi';
  if(statsPeriod==='settimana')return 'Ultima settimana';
  if(statsPeriod==='mese')return 'Questo mese';
  if(statsPeriod==='anno')return "Quest'anno";
  if(statsPeriod==='custom'&&statFrom&&statTo)return `${statFrom} → ${statTo}`;
  return 'Periodo';
}
function barChart(data,cls=''){
  const max=Math.max(1,...Object.values(data));
  return Object.entries(data).map(([k,v])=>`<div class="bar-row">
    <div class="bar-label">${k}</div>
    <div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.round(v/max*100)}%"><span>${v}</span></div></div>
  </div>`).join('');
}
function kpiBox(v,l,cls=''){return`<div class="kpi"><div class="v ${cls}">${v}</div><div class="l">${l}</div></div>`;}

function renderStats(){
  const r=SESSION.role;
  // custom period row
  $('customPeriod').style.display=statsPeriod==='custom'?'flex':'none';

  if(r==='admin'){renderAdminStats();return;}

  const salon=getSalon();if(!salon)return;
  let allBks=STATE.bookings.filter(b=>b.salonId===salon.id&&b.status!=='cancelled');
  // A barber only ever sees their own numbers here, never other barbers'.
  if(r==='barber')allBks=allBks.filter(b=>b.workerId===SESSION.workerId);

  const filtered=filterByPeriod(allBks);                    // prenotati nel periodo selezionato
  const served=filtered.filter(b=>b.status==='completed');  // serviti — solo confermati "Fatto" dal barbiere
  const servedRev=served.reduce((s,b)=>s+(b.price||0),0);   // incasso reale, solo chi ha ricevuto il servizio

  let html=`
  <div class="chart-title" style="margin-top:0;">${periodLabel()}</div>
  <div class="kpi-row">
    ${kpiBox(filtered.length,'Prenotati','amber')}
    ${kpiBox(served.length,'Serviti','green')}
  </div>
  <div class="kpi-row">
    ${kpiBox('€'+servedRev,'Incasso reale (solo serviti)','green')}
  </div>`;

  // Servizi realizzati per tipo — solo status "completed", mai i soli prenotati
  if(served.length){
    const sMap={};
    served.forEach(b=>{sMap[b.service]=(sMap[b.service]||0)+1;});
    html+=`<div class="chart-wrap"><div class="chart-title">Servizi realizzati per tipo</div><div class="bar-chart">${barChart(sMap,'green')}</div></div>`;
  }

  // Solo owner: ripartizione per barbiere (servizi realizzati + incasso) e per servizio (incasso)
  if(r==='owner'&&served.length){
    const wMap={};
    served.forEach(b=>{wMap[b.workerName]=(wMap[b.workerName]||0)+1;});
    html+=`<div class="chart-wrap"><div class="chart-title">Servizi realizzati per barbiere</div><div class="bar-chart">${barChart(wMap,'blue')}</div></div>`;

    const wRev={};
    served.forEach(b=>{wRev[b.workerName]=(wRev[b.workerName]||0)+(b.price||0);});
    html+=`<div class="chart-wrap"><div class="chart-title">Incasso per barbiere (€, solo serviti)</div><div class="bar-chart">${barChart(wRev,'green')}</div></div>`;

    const svcRev={};
    served.forEach(b=>{svcRev[b.service]=(svcRev[b.service]||0)+(b.price||0);});
    html+=`<div class="chart-wrap"><div class="chart-title">Incasso per servizio (€, solo serviti)</div><div class="bar-chart">${barChart(svcRev,'green')}</div></div>`;

    // Tabella riepilogativa per barbiere: periodo | barbiere | clienti serviti | incasso
    const workerRows=salon.workers.map(w=>{
      const wServed=served.filter(b=>b.workerId===w.id);
      const wRevTot=wServed.reduce((sum,b)=>sum+(b.price||0),0);
      return {name:w.name, count:wServed.length, rev:wRevTot};
    });
    html+=`<div class="chart-wrap">
      <div class="chart-title">Riepilogo per barbiere</div>
      ${statsTableHtml('Barbiere', workerRows, served.length, servedRev)}
    </div>`;

    lastStatsExport={
      title:salon.name,
      subtitle:`Riepilogo statistiche · ${periodLabel()}`,
      colLabel:'Barbiere', rows:workerRows, servedCount:served.length, servedRev, period:periodLabel()
    };
  }

  $('statsContent').innerHTML=html;
}

function renderAdminStats(){
  // Admin: panoramica di tutti i saloni, per il periodo selezionato
  const allBks=STATE.bookings.filter(b=>b.status!=='cancelled');
  const filtered=filterByPeriod(allBks);                     // prenotati (tutti i saloni)
  const served=filtered.filter(b=>b.status==='completed');   // serviti — solo confermati "Fatto"
  const servedRev=served.reduce((s,b)=>s+(b.price||0),0);    // incasso reale, solo chi ha ricevuto il servizio
  const wCount=STATE.salons.reduce((s,x)=>s+x.workers.length,0);

  let html=`
  <div class="chart-title" style="margin-top:0;">${periodLabel()}</div>
  <div class="kpi-row">
    ${kpiBox(STATE.salons.length,'Saloni attivi')}
    ${kpiBox(wCount,'Dipendenti totali','blue')}
  </div>
  <div class="kpi-row">
    ${kpiBox(filtered.length,'Prenotati','amber')}
    ${kpiBox(served.length,'Serviti','green')}
  </div>
  <div class="kpi-row">
    ${kpiBox('€'+servedRev,'Incasso reale (solo serviti)','green')}
  </div>`;

  // Servizi realizzati per tipo, su tutti i saloni — solo status "completed"
  if(served.length){
    const sMap={};
    served.forEach(b=>{sMap[b.service]=(sMap[b.service]||0)+1;});
    html+=`<div class="chart-wrap"><div class="chart-title">Servizi realizzati per tipo</div><div class="bar-chart">${barChart(sMap,'green')}</div></div>`;
  }

  // Tabella riepilogativa per salone: periodo | salone | clienti serviti | incasso
  const rows=STATE.salons.map(s=>{
    const sServed=served.filter(b=>b.salonId===s.id);
    const sRev=sServed.reduce((sum,b)=>sum+(b.price||0),0);
    return {name:s.name, count:sServed.length, rev:sRev};
  });
  html+=`<div class="chart-wrap">
    <div class="chart-title">Riepilogo per salone</div>
    ${statsTableHtml('Salone', rows, served.length, servedRev)}
  </div>`;

  $('statsContent').innerHTML=html;

  // Kept for the export/print button (event-delegated, wired once in boot()).
  lastStatsExport={
    title:'TRIMIO',
    subtitle:`Riepilogo statistiche · Tutti i saloni · ${periodLabel()}`,
    colLabel:'Salone', rows, servedCount:served.length, servedRev, period:periodLabel()
  };
}

// Shared table markup for the admin (per-salone) and owner (per-barbiere)
// statistics exports — only the column label and row data differ.
function statsTableHtml(colLabel, rows, servedCount, servedRev){
  return `
    <button type="button" class="stats-export-btn" id="statsExportBtn">📄 Esporta PDF / Stampa</button>
    <div style="overflow-x:auto;">
    <table class="gtable">
      <thead><tr>
        <th>Periodo</th>
        <th>${colLabel}</th>
        <th style="text-align:right;">Clienti serviti</th>
        <th style="text-align:right;">Incasso (€)</th>
      </tr></thead>
      <tbody>
        ${rows.map(row=>`<tr>
          <td class="gtable-muted">${periodLabel()}</td>
          <td style="font-weight:700;">${escapeHtml(row.name)}</td>
          <td style="text-align:right;">${row.count}</td>
          <td style="text-align:right;font-weight:700;color:#16a34a;">€${row.rev}</td>
        </tr>`).join('')}
        <tr class="gtable-total">
          <td></td>
          <td>Totale</td>
          <td style="text-align:right;">${servedCount}</td>
          <td style="text-align:right;color:#16a34a;">€${servedRev}</td>
        </tr>
      </tbody>
    </table>
    </div>`;
}

// Shared PDF/print builder for both the admin (per-salone) and owner
// (per-barbiere) statistics tables — d.colLabel/d.title differ, everything
// else about the layout is identical.
function printStatsExport(){
  const d=lastStatsExport;
  const target=$('printableStats');
  if(!d||!target)return;
  target.innerHTML=`
    <div class="ps-header">
      <div class="ps-title">${d.title}</div>
      <div class="ps-sub">${d.subtitle}</div>
    </div>
    <table>
      <thead><tr>
        <th>Periodo</th><th>${d.colLabel}</th><th style="text-align:right">Clienti serviti</th><th style="text-align:right">Incasso (€)</th>
      </tr></thead>
      <tbody>
        ${d.rows.map(row=>`<tr>
          <td>${d.period}</td><td>${row.name}</td>
          <td style="text-align:right">${row.count}</td>
          <td style="text-align:right">€${row.rev}</td>
        </tr>`).join('')}
        <tr style="font-weight:800;">
          <td></td><td>Totale</td>
          <td style="text-align:right">${d.servedCount}</td>
          <td style="text-align:right">€${d.servedRev}</td>
        </tr>
      </tbody>
    </table>`;
  window.print();
}

/* ---- SALONI (solo Livello 1 admin) ---- */
function renderSaloni(){
  let html='';
  STATE.salons.forEach(s=>{
    const tot=STATE.bookings.filter(b=>b.salonId===s.id&&b.status!=='cancelled').length;
    const locationString = s.address ? `#${s.slug} · ${s.city||'—'} (${s.address})` : `#${s.slug} · ${s.city||'—'}`;
    const statusBtn = `
      <button class="status-toggle-btn" data-stoggle="${s.id}" style="padding:6px 12px; border-radius:10px; border:none; font-size:11px; font-weight:800; cursor:pointer; background:${s.inactive ? '#ef4444' : '#10b981'}; color:#fff; transition:all .15s;">
        ${s.inactive ? 'Inattivo' : 'Attivo'}
      </button>`;
    html+=`<div class="salon-item">
      <div style="width:40px;height:40px;border-radius:12px;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex-shrink:0">${initials(s.name)}</div>
      <div class="si-info"><div class="si-name">${s.name}</div><div class="si-slug">${locationString}</div><div class="si-stats">${s.workers.length} barbieri · ${tot} prenotazioni</div></div>
      <div class="si-btns" style="display:flex; align-items:center; gap:8px;">
        ${statusBtn}
        <button class="iconbtn" data-sedit="${s.id}">✏️</button>
        <button class="iconbtn del" data-sdel="${s.id}">🗑️</button>
      </div>
    </div>`;
  });
  $('saloniList').innerHTML=html||`<div class="empty"><div class="empty-t">Nessun salone</div></div>`;
  $('saloniList').querySelectorAll('[data-sedit]').forEach(b=>b.addEventListener('click',()=>openSalonModal(b.dataset.sedit)));
  $('saloniList').querySelectorAll('[data-stoggle]').forEach(b=>b.addEventListener('click',async()=>{
    const s = STATE.salons.find(x => x.id === b.dataset.stoggle);
    if(s){
      const newInactive = !s.inactive;
      // Salon ids are predictable and public, so the server requires the
      // admin's real password before it will touch this — same proof asked
      // by "Elimina definitivamente" below and by Zona Pericolosa.
      const adminPassword = prompt('Conferma la tua password di amministratore per procedere:');
      if (adminPassword === null) return;
      try {
        const resp = await fetch('/api/toggle-salon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ salonId: s.id, inactive: newInactive, adminPassword })
        });
        const result = await resp.json();
        if (result.success) {
          s.inactive = newInactive;
          // Also save to localStorage
          try { localStorage.setItem(SK, JSON.stringify(STATE)); } catch(e){}
          renderSaloni();
        } else {
          alert('Errore nel salvare lo stato: ' + (result.error || 'Sconosciuto'));
        }
      } catch (err) {
        alert('Errore di connessione al server: ' + err.message);
      }
    }
  }));
  $('saloniList').querySelectorAll('[data-sdel]').forEach(b=>b.addEventListener('click',async()=>{
    const s = STATE.salons.find(x => x.id === b.dataset.sdel);
    const sname = s ? s.name : '';
    if (!confirm(`ATTENZIONE: Stai per eliminare definitivamente il salone "${sname}" con tutti i dipendenti e le prenotazioni! Continuare?`)) return;
    const adminPassword = prompt('Per confermare l\'eliminazione, inserisci la tua password di amministratore:');
    if (adminPassword === null) return;
    // Deletion goes through a dedicated endpoint that acts on the current
    // server-side salon list directly, instead of saveState()'s generic
    // whole-array sync (which merges by id and never deletes based on a
    // client's local snapshot missing an entry).
    try {
      const resp = await fetch('/api/delete-salon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salonId: b.dataset.sdel, adminPassword })
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert('Errore durante l\'eliminazione: ' + (err.message || err.error || 'sconosciuto'));
        return;
      }
    } catch (err) {
      alert('Errore di connessione al server: ' + err.message);
      return;
    }
    STATE.salons=STATE.salons.filter(x=>x.id!==b.dataset.sdel);
    STATE.bookings=STATE.bookings.filter(x=>x.salonId!==b.dataset.sdel);
    renderSaloni();
  }));
}
let salonEditId=null;
// Galleria del salone in modifica: copia di lavoro finché non si salva.
let smGalleryTemp=[];
// Colore tema del salone in modifica: copia di lavoro finché non si salva.
let smThemeColor='#e5c158';
function renderSmThemeSwatches(){
  const wrap=$('smThemeSwatches');
  if(!wrap)return;
  wrap.innerHTML=SALON_THEME_PALETTE.map(c=>`
    <button type="button" data-hex="${c.hex}" title="${c.name}" style="width:34px; height:34px; border-radius:50%; background:${c.hex}; cursor:pointer; border:3px solid ${c.hex===smThemeColor?'#18181b':'transparent'}; box-shadow:0 0 0 1px #e4e4e7;"></button>
  `).join('');
  wrap.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    smThemeColor=b.dataset.hex;renderSmThemeSwatches();
  }));
}
function renderSmGallery(){
  const wrap=$('smGalleryList');
  if(!wrap)return;
  wrap.innerHTML=smGalleryTemp.map((u,i)=>`
    <div style="position:relative; width:64px; height:64px;">
      <img src="${u}" alt="" style="width:64px; height:64px; border-radius:10px; object-fit:cover; background:#f4f4f5;">
      <button type="button" class="sm-gal-del" data-i="${i}" title="Rimuovi" style="position:absolute; top:-7px; right:-7px; width:20px; height:20px; border-radius:50%; border:none; background:#dc2626; color:#fff; font-size:12px; line-height:1; cursor:pointer;">✕</button>
    </div>`).join('')||'<div style="font-size:11px; color:#a1a1aa;">Nessuna foto nella galleria.</div>';
  wrap.querySelectorAll('.sm-gal-del').forEach(b=>b.addEventListener('click',()=>{
    smGalleryTemp.splice(+b.dataset.i,1);renderSmGallery();
  }));
}

function openSalonModal(sid){
  clearErr('smErr');salonEditId=sid;
  
  // Reset tabs to default active 'Dati Principali'
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
  ['panelSalonInfo', 'panelSalonStaff', 'panelSalonServices'].forEach(p => $(p).style.display = 'none');
  $('tabSalonInfo').classList.add('active');
  $('panelSalonInfo').style.display = 'block';

  $('smBgImageStatus').textContent='';
  if($('smGalleryStatus'))$('smGalleryStatus').textContent='';
  if(sid==='new'){
    $('salonModalH').textContent='Nuovo salone';
    ['smName','smSlug','smCity','smAddress','smPhone','smPromo','smOwnerUser','smOwnerPwd','smBgImage'].forEach(id=>$(id).value='');
    $('smBgImagePreview').style.display='none';
    smGalleryTemp=[];renderSmGallery();
    smThemeColor='#e5c158';renderSmThemeSwatches();

    // Hide staff and services tabs for new unsaved salons
    $('tabSalonStaff').style.display = 'none';
    $('tabSalonServices').style.display = 'none';
  } else {
    const s=STATE.salons.find(x=>x.id===sid);if(!s)return;
    $('salonModalH').textContent='Modifica · '+s.name;
    $('smName').value=s.name;$('smSlug').value=s.slug;$('smCity').value=s.city||'';
    $('smAddress').value=s.address||'';$('smPhone').value=s.phone||'';
    $('smPromo').value=s.promo||'';
    $('smOwnerUser').value=s.ownerUsername||'';$('smOwnerPwd').value=s.ownerPassword||'';
    $('smBgImage').value=s.bgImage||'';
    if(s.bgImage){$('smBgImagePreview').src=s.bgImage;$('smBgImagePreview').style.display='block';}
    else{$('smBgImagePreview').style.display='none';}
    smGalleryTemp=(s.gallery||[]).slice();renderSmGallery();
    smThemeColor=s.themeColor||'#e5c158';renderSmThemeSwatches();

    // Show tabs for existing salons
    $('tabSalonStaff').style.display = '';
    $('tabSalonServices').style.display = '';

    // Render sub-lists
    renderSalonModalWorkers(s);
    renderSalonModalServices(s);
  }

  $('salonModal').classList.add('show');
  
  // Reset scroll of modal-sheet so it is at the top
  const sheet = $('salonModal').querySelector('.modal-sheet');
  if (sheet) sheet.scrollTop = 0;
}

async function saveSalon(){
  const name=$('smName').value.trim();
  const slug=$('smSlug').value.trim().toUpperCase().replace(/[^A-Z0-9_]/g,'');
  const city=$('smCity').value.trim();
  const address=$('smAddress').value.trim();
  const phone=$('smPhone').value.trim();
  const promo=$('smPromo').value.trim();
  const oUser=$('smOwnerUser').value.trim(),oPwd=$('smOwnerPwd').value.trim();
  const bgImg=$('smBgImage').value.trim();
  if(name.length<2)return showErr('smErr','Inserisci il nome del salone');
  if(!slug)return showErr('smErr','Inserisci lo slug');
  if(!phone)return showErr('smErr','Il numero di telefono è obbligatorio');
  if(!isValidItalianPhone(phone))return showErr('smErr','Inserisci un numero di telefono italiano valido (es. +39 035 123 4567)');

  if(salonEditId==='new'){
    if(!oUser||!oPwd)return showErr('smErr','Username e password proprietario obbligatori');
    STATE.salons.push({
      id:'salon'+Date.now(),name,slug,city,address,phone,promo,bgImage:bgImg,gallery:smGalleryTemp.slice(),themeColor:smThemeColor,closedDays:[],bookingDays:30,
      services:DEFAULT_SERVICES.map(s=>({...s})),workers:[],ownerUsername:oUser,ownerPassword:oPwd
    });
  } else {
    const s=STATE.salons.find(x=>x.id===salonEditId);if(!s)return;
    s.name=name;s.slug=slug;s.city=city;s.address=address;s.phone=phone;s.promo=promo;s.bgImage=bgImg;
    s.gallery=smGalleryTemp.slice();s.themeColor=smThemeColor;
    if(oUser)s.ownerUsername=oUser;
    // Owner password lives only server-side now — changing it goes through
    // the verified admin_set endpoint, never the generic bulk save.
    if(oPwd){
      const r = await adminSetPassword({ targetType: 'owner', salonId: s.id, newPassword: oPwd });
      if (!r || !r.success) return; // adminSetPassword already alerted the reason
    }

    // Save Services list prices and durations
    const priceInputs = $('smServicesList').querySelectorAll('.sm-svc-price');
    const durInputs = $('smServicesList').querySelectorAll('.sm-svc-dur');
    
    priceInputs.forEach(input => {
      const name = input.dataset.name;
      const price = parseInt(input.value) || 0;
      const svc = s.services.find(x => x.name === name);
      if (svc) svc.price = price;
    });
    
    durInputs.forEach(input => {
      const name = input.dataset.name;
      const dur = input.value.trim() || '30 min';
      const svc = s.services.find(x => x.name === name);
      if (svc) svc.dur = dur;
    });
  }
  await saveState();closeModal('salonModal');renderSaloni();
}

/* ---- UTENTI (solo Livello 1 admin) ----
   Admin può SOLO resettare la password di proprietari e barbieri (a un valore
   di default prevedibile) — tutto il resto si gestisce da "Modifica Salone" */
let umTarget=null; // {type:'self'} — set by openSelfPasswordModal only
function renderUtenti(){
  // Admin-only, reset-only: a single cross-salon list to quickly reset an
  // owner's or barber's password if they forget it. Everything else about
  // a salon/staff member (username, name, add/remove) is managed through
  // "Modifica Salone" instead, to avoid two different places doing the
  // same job in different ways.
  let html=`<div class="sub-sec-h">Proprietari saloni</div>`;
  STATE.salons.forEach(s=>{
    html+=`<div class="worker-card">
      <div class="av">${initials(s.ownerUsername)}</div>
      <div class="wc-info"><div class="wc-name">${s.name}</div><div class="wc-meta">@${s.ownerUsername} · Proprietario (Liv. 2)</div></div>
      <div class="wc-btns">
        <button class="iconbtn" data-utype="owner" data-usid="${s.id}" title="Reset password">🔑</button>
      </div>
    </div>`;
  });
  html+=`<div class="sub-sec-h">Barbieri / Dipendenti</div>`;
  STATE.salons.forEach(s=>{
    s.workers.forEach(w=>{
      html+=`<div class="worker-card">
        <div class="av">${initials(w.name)}</div>
        <div class="wc-info"><div class="wc-name">${w.name}</div><div class="wc-meta">@${w.username} · ${s.name} · Barbiere (Liv. 3)</div></div>
        <div class="wc-btns">
          <button class="iconbtn" data-utype="barber" data-usid="${s.id}" data-uwid="${w.id}" title="Reset password">🔑</button>
        </div>
      </div>`;
    });
  });
  $('utentiList').innerHTML=html;
  // Reset is immediate and always lands on the same predictable default
  // (name+123) — computed server-side now (defaultResetPassword lives in
  // api/change-password.js too) since the client can't touch passwords
  // directly anymore. The admin's own current password is required as
  // proof of identity, same pattern as /api/reset-all-data.
  $('utentiList').querySelectorAll('[data-utype="owner"]').forEach(b=>b.addEventListener('click',async()=>{
    const s=STATE.salons.find(x=>x.id===b.dataset.usid);if(!s)return;
    if(!confirm(`Reimpostare la password di "${s.ownerUsername}" (Proprietario · ${s.name}) al valore predefinito?`))return;
    const r = await adminSetPassword({ targetType: 'owner', salonId: s.id });
    if (r && r.success) alert(`Password reimpostata: ${r.newPassword}`);
  }));
  $('utentiList').querySelectorAll('[data-utype="barber"]').forEach(b=>b.addEventListener('click',async()=>{
    const s=STATE.salons.find(x=>x.id===b.dataset.usid);const w=s?.workers.find(x=>x.id===b.dataset.uwid);if(!w)return;
    if(!confirm(`Reimpostare la password di "${w.name}" (${s.name}) al valore predefinito?`))return;
    const r = await adminSetPassword({ targetType: 'barber', salonId: s.id, workerId: w.id });
    if (r && r.success) alert(`Password reimpostata: ${r.newPassword}`);
  }));
}

// Shared helper for every admin-only password mutation (reset to default,
// or set an explicit new one from the salon editor) — always proven via the
// admin's own current password, since there is no server-side session to
// check otherwise. Returns the parsed response, or null on network failure.
async function adminSetPassword({ targetType, salonId, workerId, newPassword }){
  const adminPassword = prompt('Conferma la tua password di amministratore per procedere:');
  if (adminPassword === null) return null;
  try {
    const resp = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'change_password', type: 'admin_set', adminPassword, targetType, salonId, workerId, newPassword })
    });
    const r = await resp.json().catch(() => ({}));
    if (!r.success) {
      alert(r.error === 'wrong_admin_password' ? 'Password amministratore errata.' : 'Errore durante l\'operazione.');
      return null;
    }
    return r;
  } catch (e) {
    alert('Errore di connessione al server.');
    return null;
  }
}
async function saveUserModal(){
  // The only remaining caller of this modal is the owner/barber self-service
  // password change (openSelfPasswordModal) — admin reset now happens
  // directly from renderUtenti() without a modal at all.
  const t=umTarget;if(!t||t.type!=='self')return;
  const curPwd=$('umCurPwd').value;
  const pwd=$('umPwd').value.trim();
  const pwd2=$('umPwd2').value;
  if(pwd.length<4)return showErr('umErr','La nuova password deve avere almeno 4 caratteri.');
  if(pwd!==pwd2)return showErr('umErr','Le due password non coincidono.');
  const salon=getSalon();if(!salon)return;
  if(SESSION.role!=='owner'&&SESSION.role!=='barber')return;
  try {
    const resp = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'change_password',
        type: 'self',
        role: SESSION.role,
        salonId: salon.id,
        workerId: SESSION.role === 'barber' ? SESSION.workerId : undefined,
        currentPassword: curPwd,
        newPassword: pwd
      })
    });
    const r = await resp.json().catch(() => ({}));
    if (!r.success) {
      return showErr('umErr', r.error === 'wrong_current_password' ? 'Password attuale non corretta.' : 'Errore durante il cambio password.');
    }
  } catch (e) {
    return showErr('umErr', 'Errore di connessione al server.');
  }
  closeModal('userModal');
  alert('Password aggiornata con successo.');
}

// Owner/barber self-service password change, reachable from the sidebar —
// unlike the admin reset above, this requires the CURRENT password first
// since the user is changing their own credentials, not an admin overriding
// someone else's.
function openSelfPasswordModal(){
  umTarget={type:'self'};
  clearErr('umErr');
  $('userModalH').textContent='Cambia la tua password';
  $('umFields').innerHTML=`
    <label class="d-lbl">Password attuale</label>
    <input class="minput" id="umCurPwd" type="password" placeholder="Password attuale" style="margin-bottom:14px">
    <label class="d-lbl">Nuova password</label>
    <input class="minput" id="umPwd" type="password" placeholder="Nuova password" style="margin-bottom:14px">
    <label class="d-lbl">Conferma nuova password</label>
    <input class="minput" id="umPwd2" type="password" placeholder="Ripeti nuova password" style="margin-bottom:14px">
  `;
  $('userModal').classList.add('show');
}

/* ---- MODAL NUOVO APPUNTAMENTO (Livelli 2 e 3) ----
   Livello 2 (owner): sceglie il barbiere
   Livello 3 (barber): barbiere fisso a se stesso */
function openNewApptModal(){
  const salon=getSalon();if(!salon)return;
  clearErr('mErr');$('mName').value='';
  // barbiere selector
  const isOwner=SESSION.role==='owner';
  $('mBarberWrap').style.display=isOwner?'block':'none';
  if(isOwner){
    $('mBarber').innerHTML=salon.workers.map(w=>`<option value="${w.id}">${w.name}</option>`).join('');
  } else {
    $('mBarber').innerHTML=`<option value="${SESSION.workerId}">${SESSION.name}</option>`;
  }
  $('mDate').innerHTML=openDays(salon).map(d=>`<option value="${d.iso}">${d.isToday?'Oggi · ':''}${d.label}</option>`).join('');
  $('mSrv').innerHTML=(salon.services||DEFAULT_SERVICES).map(s=>`<option value="${s.id}">${s.name} · €${s.price}</option>`).join('');
  fillModalTimes();
  $('modal').classList.add('show');
}
function fillModalTimes(){
  const salon=getSalon();if(!salon)return;
  const iso=$('mDate').value;const wid=$('mBarber').value;
  // Orari dipendenti dalla durata del servizio selezionato, come nel flusso
  // cliente: ogni prenotazione libera il barbiere alla fine effettiva del
  // servizio, non alla mezz'ora successiva. Lista fissa a 30 min, vedi
  // freeGridTimesFor.
  const srv=(salon.services||DEFAULT_SERVICES).find(s=>s.id===$('mSrv').value);
  const dur=serviceDurMin(salon,srv?srv.name:null);
  const prev=$('mTime').value;
  const times=freeGridTimesFor(salon,wid,iso,dur);
  $('mTime').innerHTML=times.length
    ? times.map(t=>`<option value="${t}">${t}</option>`).join('')
    : `<option value="" disabled selected>Nessun orario disponibile</option>`;
  if(prev&&times.includes(prev))$('mTime').value=prev;
}
// Same double-tap protection as doSubmit: one in-flight save at a time.
let manualApptSaving=false;
async function saveManualAppt(){
  if(manualApptSaving)return;
  const salon=getSalon();if(!salon)return;
  const name=$('mName').value.trim();const iso=$('mDate').value;const time=$('mTime').value;
  const wid=$('mBarber').value;const worker=salon.workers.find(w=>w.id===wid);
  const srv=(salon.services||DEFAULT_SERVICES).find(s=>s.id===$('mSrv').value);
  if(name.length<2)return showErr('mErr','Inserisci il nome del cliente');
  if(!time||$('mTime').options[$('mTime').selectedIndex]?.disabled)return showErr('mErr','Seleziona un orario disponibile');
  manualApptSaving=true;
  const saveBtn=$('mSave');
  if(saveBtn){saveBtn.disabled=true;saveBtn.textContent='…';}
  try{
    const bk={
      id:'bk'+Date.now()+Math.random().toString(36).slice(2,6),
      salonId:salon.id,workerId:wid,workerName:worker?.name||'',
      name,dateISO:iso,dateLabel:dayLabel(iso),time,
      service:srv?.name||'—',price:srv?.price||0,dur:parseInt(srv?.dur,10)||30,
      status:'confirmed',source:'manual',createdAt:new Date().toISOString()
    };
    STATE.bookings.push(bk);
    const r=await saveState();

    if(r.conflicts.some(c=>c.id===bk.id)||!r.ok){
      STATE.bookings=STATE.bookings.filter(x=>x.id!==bk.id);
      fillModalTimes();
      return showErr('mErr', r.conflicts.length ? 'Questo orario è appena stato occupato, scegli un altro orario.' : 'Impossibile salvare la prenotazione, riprova.');
    }

    closeModal('modal');
    if(curSec==='oggi'){
      dashDateISO=iso;
      const chip=[...$('oggiDates').querySelectorAll('.chip')].find(c=>c.dataset.iso===iso);
      if(chip){$('oggiDates').querySelectorAll('.chip').forEach(x=>x.classList.remove('sel'));chip.classList.add('sel');}
    }
    renderDash();
  } finally {
    manualApptSaving=false;
    if(saveBtn){saveBtn.disabled=false;saveBtn.textContent='Salva appuntamento';}
  }
}

/* ---- SIDEBAR & MODALS ---- */
function openSide(){$('side').classList.add('show');$('ov').classList.add('show');}
function closeSide(){$('side').classList.remove('show');$('ov').classList.remove('show');}
function closeModal(id){$(id).classList.remove('show');}

/* ---- ERRORS ---- */
function showErr(el,msg){const e=$(el);e.textContent=msg;e.classList.add('show');e.scrollIntoView({behavior:'smooth',block:'center'});return false;}
function clearErr(el){$(el).classList.remove('show');}
function showInfo(el,msg){$(el).textContent=msg;$(el).classList.add('show');}
function clearInfo(el){$(el).classList.remove('show');}

/* ================================================================
   BOOT
================================================================ */
/* ================================================================
   HOMEPAGE — lista saloni con link
================================================================ */
function getCurrentBaseURL(){
  // Origin only: the page may live on a /s/SLUG path, which must never leak
  // into links built for OTHER salons.
  const loc=(window.location.origin||'')+'/';
  if(!loc.startsWith('http') || loc.includes('localhost') || loc.includes('127.0.0.1')){
    // Dynamic fallback to the live Vercel URL so the QR code can be scanned on mobile from localhost/local file
    return 'https://trimio.org/';
  }
  return loc;
}
function renderHomepage(){
  const base=getCurrentBaseURL();
  const salons=STATE.salons.filter(s => !s.inactive);
  $('hpCount').textContent=salons.length+' salon'+(salons.length===1?'e':'i')+' attiv'+(salons.length===1?'o':'i');
  // Hidden while an admin session is already active — clicking it would just
  // dump the logged-in admin onto a blank login form instead of doing anything useful.
  if($('hpAdminBtn')) $('hpAdminBtn').style.display=(SESSION&&SESSION.role==='admin')?'none':'block';
  // The desktop nav bar's "Accesso Admin" CTA doubles as the dashboard
  // shortcut once already logged in — but that alone left an admin with no
  // way to log out without first entering the dashboard, since the shared
  // header (and its "Esci" option) is hidden on vHome at desktop widths.
  const isAdminSession = SESSION && SESSION.role === 'admin';
  if($('hpNavAdmin')) $('hpNavAdmin').textContent = isAdminSession ? 'Pannello Admin' : 'Accesso Admin';
  if($('hpNavLogout')) $('hpNavLogout').style.display = isAdminSession ? '' : 'none';
  if(!salons.length){
    $('hpSalonList').innerHTML=`<div class="empty"><div class="empty-ic">🏪</div><div class="empty-t">Nessun salone ancora.<br>Accedi come Admin per crearne uno.</div></div>`;
    $('hpAdBannerContainer').innerHTML = '';
    return;
  }

  // Render Homepage Ad dynamically
  const ad = STATE.homepageAd || { title: '', description: '', btnText: '', code: '' };
  if (ad.description) {
    $('hpAdBannerContainer').innerHTML = `
      <div class="hp-ad-banner">
        <div class="ad-glow"></div>
        <div class="ad-content">
          <span class="ad-tag">Sponsorizzato</span>
          <h3>${ad.title || 'TRIMIO'}</h3>
          <p>${ad.description}</p>
          <button class="ad-btn" id="hpAdBtn">${ad.btnText || 'Copia'}</button>
        </div>
      </div>`;
    
    // Wire copy button
    const btn = $('hpAdBtn');
    if (btn && ad.code) {
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(ad.code).then(() => {
          btn.textContent = '✓ Copiato!';
          setTimeout(() => btn.textContent = ad.btnText || 'Copia', 2000);
        }).catch(() => alert('Codice: ' + ad.code));
      });
    }
  } else {
    $('hpAdBannerContainer').innerHTML = '';
  }

  $('hpSalonList').innerHTML=salons.map(s=>{
    const link=base+'#'+s.slug;
    const todayBks=STATE.bookings.filter(b=>b.salonId===s.id&&b.dateISO===todayISO()&&b.status!=='cancelled').length;
    const totBks=STATE.bookings.filter(b=>b.salonId===s.id&&b.status!=='cancelled').length;
    
    // Build address and contact display
    const addressDisplay = s.address ? `📍 ${s.address}, ${s.city || '—'}` : `📍 ${s.city || '—'}`;
    const phoneDisplay = s.phone ? `
      <div style="font-size:12.5px; color:#444; margin-top:5px; display:flex; align-items:center; gap:5px;" onclick="event.stopPropagation();">
        📞 <a href="tel:${s.phone}" style="color:#4f46e5; text-decoration:none; font-weight:700;">${s.phone}</a>
      </div>` : '';
      
    const promoDisplay = s.promo ? `
      <div class="hsc-ad" onclick="event.stopPropagation(); alert('${s.promo.replace(/'/g, "\\'")}');">
        <span class="hsc-ad-tag">PROMO</span>
        <span class="hsc-ad-text">${s.promo}</span>
      </div>` : '';
      
    const distanceDisplay = s.distance !== undefined ? `
      <div style="font-size:11.5px; color:#e5c158; margin-top:4px; font-weight:700; display:flex; align-items:center; gap:4px;">
        📏 ${s.distance.toFixed(1)} km da te
      </div>` : '';

    return`<div class="hp-salon-card" data-slug="${s.slug}">
      <div class="hsc-image" style="height: 130px; background-image: url('${s.bgImage || 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=500&q=70&fit=crop'}'); background-size: cover; background-position: center; border-radius: 18px 18px 0 0; position: relative;">
        <div style="position: absolute; bottom: 0; left: 0; right: 0; padding: 12px; background: linear-gradient(to top, rgba(0,0,0,0.85), transparent); display: flex; align-items: center; gap: 10px;">
          <div class="hsc-av" style="width:36px; height:36px; font-size:14px; border-radius:8px; border:1.5px solid #e5c158; background:rgba(0,0,0,0.9);">${s.name.slice(0,2).toUpperCase()}</div>
          <div class="hsc-name" style="color:#fff; font-size:17px; text-shadow: 0 2px 4px rgba(0,0,0,0.5);">${s.name}</div>
        </div>
      </div>
      <div style="padding:14px 16px 8px;">
        <div class="hsc-info">
          <div class="hsc-city" style="color:#555;">${addressDisplay}</div>
          ${phoneDisplay}
          ${distanceDisplay}
        </div>
        <div class="hsc-stats" style="margin-top: 10px;">
          <div class="hsc-stat">💈 ${s.workers.length} barbieri</div>
          <div class="hsc-stat">📅 Oggi: ${todayBks} prenotazioni</div>
          <div class="hsc-stat">📊 Totale: ${totBks}</div>
        </div>
        ${promoDisplay}
      </div>
      <div class="hsc-actions-row" style="display:flex; border-top:1px solid #f0f0f0;">
        <button class="hsc-open-btn" data-slug="${s.slug}" style="flex:1; border-radius:0 0 0 18px;">Apri prenotazioni →</button>
        <button class="hsc-qr-btn" data-slug="${s.slug}" style="width:70px; border-radius:0 0 18px 0;" title="Mostra QR Code">📲</button>
      </div>
    </div>`;
  }).join('');

  // click: apri salone
  $('hpSalonList').querySelectorAll('[data-slug]').forEach(el=>{
    el.addEventListener('click',e=>{
      if(e.target.closest('button') || e.target.closest('a')) return;
      const s=STATE.salons.find(x=>x.slug===el.dataset.slug);
      if(s){location.hash='#'+s.slug;initCustomer(s);showView('vCustomer');}
    });
  });
  // .hsc-open-btn
  $('hpSalonList').querySelectorAll('.hsc-open-btn').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation();
    const s=STATE.salons.find(x=>x.slug===btn.dataset.slug);
    if(s){location.hash='#'+s.slug;initCustomer(s);showView('vCustomer');}
  }));
  // .hsc-qr-btn
  $('hpSalonList').querySelectorAll('.hsc-qr-btn').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation();
    showSalonQRCode(btn.dataset.slug);
  }));
}

// Pure social-proof photo grid on the marketing entry point (vLogin) — the
// same cover photo an admin already sets per salon via Gestione Saloni, but
// with no name/slug/booking link surfaced, since nobody but a logged-in
// admin is meant to reach the real salon pages from this page.
function renderVLoginSalonShowcase(){
  const grid = $('vLoginSalonPhotos');
  if (!grid) return;
  const salons = STATE.salons.filter(s => !s.inactive && s.bgImage);
  if (!salons.length) { grid.innerHTML = ''; return; }
  grid.innerHTML = salons.map(s => `
    <div class="vlp-card">
      <img src="${escapeHtml(s.bgImage)}" alt="${escapeHtml(s.name)}" loading="lazy">
    </div>
  `).join('');
}

// Curated photos an admin uploads specifically for the marketing page (see
// "Foto Pagina Iniziale" in Gestione Saloni) — distinct from
// renderVLoginSalonShowcase()'s automatic per-salon bgImage grid above.
function renderVLoginPhotoGallery(){
  const wrap = $('vLoginPhotoGallery');
  const section = $('vLoginPhotoGallerySec');
  if (!wrap) return;
  const photos = (STATE.admin && STATE.admin.homepagePhotos) || [];
  if (section) section.style.display = photos.length ? '' : 'none';
  wrap.innerHTML = photos.map(u => `
    <div class="vlp-card">
      <img src="${escapeHtml(u)}" alt="TRIMIO" loading="lazy">
    </div>
  `).join('');
}

// Admin-only management list in Gestione Saloni ("Foto Pagina Iniziale").
function renderHpPhotosList(){
  const wrap = $('hpPhotosList');
  if (!wrap) return;
  const photos = (STATE.admin && STATE.admin.homepagePhotos) || [];
  wrap.innerHTML = photos.map((u, i) => `
    <div class="hp-photo-thumb">
      <img src="${escapeHtml(u)}" alt="">
      <button type="button" class="hp-photo-rm" data-i="${i}" title="Rimuovi">✕</button>
    </div>
  `).join('');
}

async function saveHomepagePhotos(){
  await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ action: 'update_homepage_photos', photos: STATE.admin.homepagePhotos || [] })
  });
}

function showSalonQRCode(slug) {
  const s = STATE.salons.find(x => x.slug === slug);
  if (!s) return;
  
  const base = getCurrentBaseURL();
  // Path-based link (/s/SLUG): the only URL form iOS keeps intact when the
  // page is added to the Home Screen (it strips #fragments and sometimes
  // query strings).
  const link = base + 's/' + encodeURIComponent(s.slug);
  
  $('qrModalH').textContent = `QR Code - ${s.name}`;
  $('qrLinkInput').value = link;
  
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(link)}`;
  $('qrCodeImg').src = qrUrl;
  
  openModal('qrModal');
}

/* ======== BARBER REVIEWS LOGIC ======== */
let activeReviewWorkerId = null;
let activeReviewStarVal = 5;

function openModal(id){$(id).classList.add('show');}

function selectReviewStar(val) {
  activeReviewStarVal = val;
  const stars = $('ratingInput').querySelectorAll('.star-select');
  stars.forEach((s, idx) => {
    s.classList.toggle('active', idx < val);
  });
}

function showBarberReviews(workerId) {
  activeReviewWorkerId = workerId;
  const w = custSalon.workers.find(x => x.id === workerId);
  if (!w) return;
  
  $('reviewsModalH').textContent = `Recensioni di ${w.name}`;
  clearErr('revErr');
  
  // Reset form inputs
  $('revAuthor').value = '';
  $('revComment').value = '';
  selectReviewStar(5);
  
  // Render reviews list
  const listEl = $('reviewsList');
  const reviews = w.reviews || [];
  if (reviews.length === 0) {
    listEl.innerHTML = `<div style="text-align:center; padding:20px; color:#999; font-size:13px;">Nessuna recensione ancora. Lascia la prima!</div>`;
  } else {
    // Sort by date desc
    const sorted = [...reviews].sort((a,b) => (b.date || '').localeCompare(a.date || ''));
    listEl.innerHTML = sorted.map(r => `
      <div class="rev-item">
        <div class="rev-header">
          <span class="rev-author">${escapeHtml(r.author)}</span>
          <span class="rev-stars">${'★'.repeat(r.rating)}${'☆'.repeat(5-r.rating)}</span>
        </div>
        <div class="rev-comment">"${escapeHtml(r.comment)}"</div>
        <span class="rev-date">${r.date || '—'}</span>
      </div>
    `).join('');
  }
  
  openModal('reviewsModal');
}

async function submitBarberReview() {
  const author = $('revAuthor').value.trim();
  const comment = $('revComment').value.trim();

  if (author.length < 2) {
    showErr('revErr', 'Inserisci il tuo nome (almeno 2 caratteri)');
    return;
  }
  if (comment.length < 5) {
    showErr('revErr', 'Inserisci un commento (almeno 5 caratteri)');
    return;
  }

  const w = custSalon.workers.find(x => x.id === activeReviewWorkerId);
  if (!w) return;

  // Reviews are written server-side only now (action=submit_review) — never
  // via the generic salons[] save, which any anonymous caller could
  // otherwise use to write anything, and which would race with another
  // customer's review submitted around the same time.
  let resData;
  try {
    const resp = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'submit_review',
        salonId: custSalon.id,
        workerId: activeReviewWorkerId,
        author, comment,
        rating: activeReviewStarVal
      })
    });
    resData = await resp.json().catch(() => ({}));
  } catch (e) {
    return showErr('revErr', 'Errore di connessione al server.');
  }
  if (!resData.success) {
    return showErr('revErr', resData.error === 'rate_limited' ? 'Troppe recensioni inviate, riprova più tardi.' : 'Errore durante l\'invio della recensione.');
  }

  // Optimistic local update so the list/grid reflect it immediately instead
  // of waiting for the next 6s poll.
  if (!w.reviews) w.reviews = [];
  w.reviews.push({ rating: activeReviewStarVal, author, comment, date: new Date().toISOString().split('T')[0] });

  // Clear and notify
  $('revAuthor').value = '';
  $('revComment').value = '';
  showBarberReviews(activeReviewWorkerId);

  // Re-render the barber grid in the background
  renderBarberGrid();
}


async function boot(){
  // An installed PWA/Home-Screen icon launches on /s/SLUG (or a legacy
  // /?s=SLUG icon) — translate the document URL into the normal #SLUG hash
  // before anything reads location, so the rest of the routing works
  // unchanged. The /s/ path itself is preserved (it's what iOS saved).
  try{
    const slug=DOC_PATH_SLUG||new URLSearchParams(location.search).get('s');
    if(slug&&!location.hash){
      history.replaceState(null,'',location.pathname+'#'+slug);
    }
  }catch(e){}

  await loadState();

  initCloudSync();



  // Wire interactive portfolio gallery filter
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const filter = tab.dataset.filter;
      document.querySelectorAll('.gallery-card').forEach(card => {
        if (filter === 'all' || card.dataset.cat === filter) {
          card.classList.remove('hide');
        } else {
          card.classList.add('hide');
        }
      });
    });
  });

  // ---- Customer wiring ----
  $('cNext').addEventListener('click',custNext);
  $('cBack').addEventListener('click',custBack);
  $('again').addEventListener('click',()=>location.reload());
  $('cname').addEventListener('input',e=>{custData.name=e.target.value;clearErr('cErr');});
  $('cphone').addEventListener('input',e=>{custData.phone=e.target.value;});
  // Formato italiano applicato quando il campo perde il focus (formattare a
  // ogni tasto sposterebbe il cursore mentre si digita).
  $('cphone').addEventListener('blur',e=>{
    if(!e.target.value.trim())return;
    const f=formatItalianPhone(e.target.value);
    e.target.value=f;custData.phone=f;
  });
  // An already-authenticated admin (the only session that ever sees
  // vHome in the first place) clicking "Accesso Admin" must go straight
  // to their dashboard — showing them the vLogin marketing pitch for a
  // product they already run, with their own credentials autofilled
  // below it, reads as broken rather than as a login screen.
  const goToAdminEntry = () => {
    if (SESSION && SESSION.role === 'admin') { showView('vDash'); initDash(); }
    else { loginSalonContext = null; loginRoleContext = null; showView('vLogin'); }
  };
  $('hpAdminBtn')?.addEventListener('click', goToAdminEntry);
  // Desktop homepage nav bar (hidden on mobile — see css) — jumps to the
  // matching section already on the page rather than duplicating them.
  $('hpNavBrand')?.addEventListener('click', () => window.scrollTo({top:0, behavior:'smooth'}));
  $('hpNavHow')?.addEventListener('click', () => $('hpHowItWorks')?.scrollIntoView({behavior:'smooth', block:'start'}));
  $('hpNavSaloni')?.addEventListener('click', () => $('hpSalonList')?.scrollIntoView({behavior:'smooth', block:'start'}));
  $('hpNavContact')?.addEventListener('click', () => $('hpContact')?.scrollIntoView({behavior:'smooth', block:'start'}));
  $('hpNavAdmin')?.addEventListener('click', goToAdminEntry);
  $('hpNavLogout')?.addEventListener('click', doLogout);
  // Admin login modal on the marketing entry point — see the .as-modal
  // toggle in showView(). Opens on the top-left trigger, closes on the
  // backdrop or the ✕ button; nothing here bypasses the actual form.
  $('vLoginAdminTrigger')?.addEventListener('click', () => $('vLoginFormOverlay')?.classList.add('show'));
  $('vLoginFormOv')?.addEventListener('click', () => $('vLoginFormOverlay')?.classList.remove('show'));
  $('loginModalClose')?.addEventListener('click', () => $('vLoginFormOverlay')?.classList.remove('show'));
  $('gear').addEventListener('click',()=>{ loginSalonContext = custSalon ? custSalon.id : null; loginRoleContext = null; showView('vLogin'); });
  $('toStaff').addEventListener('click',()=>{ loginSalonContext = custSalon ? custSalon.id : null; loginRoleContext = null; showView('vLogin'); });
  $('toCustomer').addEventListener('click',()=>{
    if(custSalon){showView('vCustomer');}
    else{renderHomepage();showView('vHome');}
  });
  $('altOv').addEventListener('click',closeAlt);
  $('altSkip').addEventListener('click',closeAlt);
  $('custGalleryLightbox')?.addEventListener('click',()=>{ $('custGalleryLightbox').style.display='none'; });
  $('custMyBookingBanner')?.addEventListener('click',renderMyBookingsModal);
  $('submitReviewBtn').addEventListener('click', submitBarberReview);
  
  // Wire Homepage photo gallery manager (Gestione Saloni -> "Foto Pagina
  // Iniziale") — each upload/removal saves immediately since there's no
  // modal-close moment here to hang a single "Save" action off of.
  $('hpPhotosFile')?.addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const st = $('hpPhotosStatus');
    if (!Array.isArray(STATE.admin.homepagePhotos)) STATE.admin.homepagePhotos = [];
    try {
      for (let i = 0; i < files.length; i++) {
        if (st) st.textContent = `Caricamento ${i + 1}/${files.length}...`;
        const url = await uploadImageFile(files[i]);
        STATE.admin.homepagePhotos.push(url);
        renderHpPhotosList();
      }
      await saveHomepagePhotos();
      if (st) st.textContent = '✓ Foto salvate';
    } catch (err) {
      if (st) st.textContent = 'Errore: ' + err.message;
    } finally {
      e.target.value = '';
    }
  });
  $('hpPhotosList')?.addEventListener('click', async e => {
    const btn = e.target.closest('.hp-photo-rm');
    if (!btn) return;
    STATE.admin.homepagePhotos.splice(+btn.dataset.i, 1);
    renderHpPhotosList();
    await saveHomepagePhotos();
  });

  // Wire Homepage Ad Editor save button
  $('saveAdBtn')?.addEventListener('click', async () => {
    if (!STATE.homepageAd) STATE.homepageAd = {};
    STATE.homepageAd.title = $('adTitleInput').value.trim();
    STATE.homepageAd.description = $('adDescInput').value.trim();
    STATE.homepageAd.btnText = $('adBtnInput').value.trim() || 'Copia';
    STATE.homepageAd.code = $('adCodeInput').value.trim();
    await saveState();
    alert('Annuncio salvato con successo!');
    renderHomepage();
  });

  // Zona Pericolosa (solo admin) — cancella permanentemente saloni/prenotazioni
  // di test, per quando si passa a saloni reali. Richiede una frase esatta
  // digitata dall'admin, non solo un confirm(), data la gravità dell'azione.
  $('resetAllDataBtn')?.addEventListener('click', async () => {
    const typed = prompt('Questa azione ELIMINA PERMANENTEMENTE tutti i saloni e le prenotazioni. Per confermare, inserisci la tua password di amministratore:');
    if (typed === null) return;
    // The client no longer holds the real admin password locally to
    // pre-check against — /api/reset-all-data verifies it server-side and
    // returns 401 if wrong.
    try {
      const resp = await fetch('/api/reset-all-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: typed })
      });
      if (resp.ok) {
        alert('Tutti i dati sono stati eliminati. La pagina verrà ricaricata.');
        location.reload();
      } else {
        const err = await resp.json().catch(() => ({}));
        alert('Errore durante l\'eliminazione: ' + (err.error || 'sconosciuto'));
      }
    } catch (e) {
      alert('Errore di connessione al server: ' + e.message);
    }
  });

  // Cambia Password Amministratore (solo admin)
  $('saveAdminCredsBtn')?.addEventListener('click', async () => {
    const curPwd = $('adminCurPwd').value;
    const newUser = $('adminNewUser').value.trim();
    const newPwd = $('adminNewPwd').value;
    const newPwd2 = $('adminNewPwd2').value;
    clearErr('adminCredsErr');
    if (!newUser) return showErr('adminCredsErr', 'Inserisci un username.');
    if (!newPwd || newPwd.length < 4) return showErr('adminCredsErr', 'La nuova password deve avere almeno 4 caratteri.');
    if (newPwd !== newPwd2) return showErr('adminCredsErr', 'Le due password non coincidono.');
    try {
      const resp = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'change_password', type: 'admin_self', currentPassword: curPwd, newUsername: newUser, newPassword: newPwd })
      });
      const r = await resp.json().catch(() => ({}));
      if (!r.success) {
        return showErr('adminCredsErr', r.error === 'wrong_current_password' ? 'Password attuale non corretta.' : 'Errore di salvataggio, riprova.');
      }
      STATE.admin.username = r.username;
      $('adminCurPwd').value = ''; $('adminNewPwd').value = ''; $('adminNewPwd2').value = '';
      $('adminNewUser').value = STATE.admin.username;
      alert('Credenziali amministratore aggiornate con successo.');
    } catch (e) {
      showErr('adminCredsErr', 'Errore di connessione al server.');
    }
  });

  // ---- Back Buttons wiring ----
  $('hBack')?.addEventListener('click', () => {
    const activeView = document.querySelector('.view.on')?.id;
    if (activeView === 'vCustomer') {
      if (typeof custStep !== 'undefined' && custStep > 0) {
        custBack();
      } else {
        if (SESSION && SESSION.role === 'admin') {
          if (history.length > 1) { history.back(); } else { showView('vHome'); }
        } else if (SESSION && SESSION.role) {
          showView('vDash');
          initDash();
        } else {
          if (history.length > 1) {
            history.back();
          } else {
            showView('vLogin');
          }
        }
      }
    } else if (activeView === 'vLogin') {
      if (custSalon) {
        showView('vCustomer');
      } else if (SESSION && SESSION.role === 'admin') {
        if (history.length > 1) { history.back(); } else { showView('vHome'); }
      } else {
        if (history.length > 1) {
          history.back();
        } else {
          showView('vLogin');
        }
      }
    }
  });

  $('dBack')?.addEventListener('click', () => {
    if (SESSION && SESSION.role === 'admin') {
      if (history.length > 1) { history.back(); } else { showView('vHome'); }
    } else if (SESSION && SESSION.role) {
      const salon = STATE.salons.find(x => x.id === SESSION.salonId);
      if (salon) {
        location.hash = salon.slug;
      } else {
        doLogout();
      }
    }
  });

  // ---- Login wiring ----
  $('loginBtn').addEventListener('click',doLogin);
  $('lusr').addEventListener('keydown',e=>{if(e.key==='Enter')$('lpw').focus();});
  $('lpw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});

  // ---- Dashboard wiring ----
  $('hamb').addEventListener('click',openSide);
  $('ov').addEventListener('click',closeSide);
  $('sideOut').addEventListener('click',doLogout);
  $('sidePwdBtn').addEventListener('click',openSelfPasswordModal);
  
  // Wire navigation dropdown menu
  $('navMenu').addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) return;
    e.target.value = ''; // Reset instantly for responsiveness
    
    if (val === 'home') {
      if (SESSION && SESSION.role === 'admin') {
        showView('vHome');
      } else {
        showView('vLogin');
      }
    } else if (val === 'booking') {
      if (custSalon) {
        showView('vCustomer');
      } else {
        showView('vLogin');
      }
    } else if (val === 'saloni_scroll') {
      if (SESSION && SESSION.role === 'admin') {
        showView('vHome');
        const el = $('hpSalonList');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        showView('vLogin');
      }
    } else if (val === 'login_admin') {
      loginSalonContext = null;
      loginRoleContext = null;
      showView('vLogin');
    } else if (val === 'login_owner') {
      loginSalonContext = custSalon ? custSalon.id : null;
      loginRoleContext = 'owner';
      showView('vLogin');
    } else if (val === 'login_barber') {
      loginSalonContext = custSalon ? custSalon.id : null;
      loginRoleContext = 'barber';
      showView('vLogin');
    } else if (val === 'dashboard') {
      showView('vDash');
      initDash();
    } else if (val === 'admin_new_salon') {
      location.hash = adminHashFor('newSalon');
    } else if (val === 'logout') {
      doLogout();
    } else if (val.startsWith('nav_')) {
      const sec = val.replace('nav_', '');
      if (SESSION && SESSION.role === 'admin') {
        location.hash = adminHashFor(sec);
      } else {
        showView('vDash');
        initDash();
        showSec(sec);
      }
    }
  });
  $('statusBadge').addEventListener('click',()=>{
    shopOpen=!shopOpen;
    $('statusBadge').className='d-status '+(shopOpen?'open':'closed');
    $('statusBadge').textContent=shopOpen?'● Aperto':'● Chiuso';
  });
  $('newBtn').addEventListener('click',openNewApptModal);
  $('calPrev').addEventListener('click',()=>calShift(-1));
  $('calNext').addEventListener('click',()=>calShift(1));
  $('cliPrev').addEventListener('click',()=>cliShift(-1));
  $('cliNext').addEventListener('click',()=>cliShift(1));
  $('modalOv').addEventListener('click',()=>closeModal('modal'));
  $('mCancel').addEventListener('click',()=>closeModal('modal'));
  $('mSave').addEventListener('click',saveManualAppt);
  $('mDate').addEventListener('change',fillModalTimes);
  $('mBarber').addEventListener('change',fillModalTimes);
  $('mSrv').addEventListener('change',fillModalTimes);
  $('addSrvBtn').addEventListener('click',()=>{editSrv='new';renderServizi();});
  $('addWorkerBtn').addEventListener('click',()=>{
    const salon=SESSION.role==='admin'?getSalonById(dipSalonId):getSalon();
    if(salon)openWorkerModal('new',salon);
  });
  $('workerModalOv').addEventListener('click',()=>closeModal('workerModal'));
  $('wCancel').addEventListener('click',()=>closeModal('workerModal'));
  $('wSave').addEventListener('click',saveWorker);
  $('breakModalOv').addEventListener('click',()=>closeModal('breakModal'));
  $('bkCancel').addEventListener('click',()=>closeModal('breakModal'));
  $('bkSave').addEventListener('click',saveBreak);
  wireImagePicker('wImgFile','wImg','wImgPreview','wImgStatus');
  $('wImg').addEventListener('input',()=>{
    const preview=$('wImgPreview');const url=$('wImg').value.trim();
    if(preview){preview.src=url;preview.style.display=url?'block':'none';}
  });
  $('wDelete').addEventListener('click',async()=>{
    const salon=STATE.salons.find(x=>x.id===workerEditSalonId);
    if(!salon||editWorker==='new')return;
    if(!confirm('Eliminare questo dipendente?'))return;
    salon.workers=salon.workers.filter(x=>x.id!==editWorker);
    await saveState();closeModal('workerModal');renderDipendenti();
  });
  $('salonModalOv').addEventListener('click',()=>closeModal('salonModal'));
  $('smCancel').addEventListener('click',()=>closeModal('salonModal'));
  $('smSave').addEventListener('click',saveSalon);
  wireImagePicker('smBgImageFile','smBgImage','smBgImagePreview','smBgImageStatus');
  // Galleria del salone: più file in una volta, ognuno compresso e caricato.
  $('smGalleryFile')?.addEventListener('change',async e=>{
    const files=Array.from(e.target.files||[]);
    if(!files.length)return;
    const st=$('smGalleryStatus');
    try{
      for(let i=0;i<files.length;i++){
        if(st)st.textContent=`Caricamento ${i+1}/${files.length}...`;
        const url=await uploadImageFile(files[i]);
        smGalleryTemp.push(url);
        renderSmGallery();
      }
      if(st)st.textContent='✓ Foto caricate — ricordati di salvare';
    }catch(err){
      if(st)st.textContent='Errore: '+err.message;
    }finally{
      e.target.value='';
    }
  });
  $('smBgImage').addEventListener('input',()=>{
    const preview=$('smBgImagePreview');const url=$('smBgImage').value.trim();
    if(preview){preview.src=url;preview.style.display=url?'block':'none';}
  });
  
  initSalonModalTabs();
  $('smAddWorkerBtn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const s = STATE.salons.find(x => x.id === salonEditId);
    if (s) {
      openWorkerModal('new', s);
    }
  });

  $('userModalOv').addEventListener('click',()=>closeModal('userModal'));
  $('umCancel').addEventListener('click',()=>closeModal('userModal'));
  $('umSave').addEventListener('click',saveUserModal);

  // period buttons
  document.querySelectorAll('.period-btn').forEach(b=>b.addEventListener('click',()=>{
    statsPeriod=b.dataset.p;
    document.querySelectorAll('.period-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const cp=$('customPeriod');
    cp.style.display=statsPeriod==='custom'?'flex':'none';
    if(curSec==='stats'&&statsPeriod!=='custom')renderStats();
  }));
  $('applyCustom')?.addEventListener('click',()=>{
    statFrom=$('statFrom').value;statTo=$('statTo').value;
    if(!statFrom||!statTo){alert('Seleziona data inizio e fine');return;}
    if(curSec==='stats')renderStats();
  });
  $('statsContent')?.addEventListener('click',(e)=>{
    if(e.target.closest('#statsExportBtn'))printStatsExport();
  });

  // hash change
  window.addEventListener('hashchange',()=>{
    updateManifestLink();
    const rawHash=(location.hash||'').replace('#','');
    if(rawHash.startsWith('admin/')){
      handleAdminHashRoute(rawHash);
      return;
    }
    const h=rawHash.toUpperCase().trim();
    if(!h){
      if (SESSION && SESSION.role === 'admin') {
        showView('vHome');
      } else if (SESSION && SESSION.role) {
        showView('vDash');
        initDash();
      } else {
        showView('vLogin');
      }
      return;
    }
    const s=STATE.salons.find(x=>x.slug===h);
    if(s){
      if(s.inactive){
        alert(`Spiacenti, il salone "${s.name}" è temporaneamente inattivo. Contatta l'amministratore.`);
        if (SESSION && SESSION.role) {
          showView('vDash');
          initDash();
        } else {
          location.hash = '';
          showView('vLogin');
        }
        return;
      }
      if (SESSION && SESSION.role !== 'admin' && SESSION.salonId && SESSION.salonId !== s.id) {
        SESSION = {role:null,salonId:null,workerId:null,name:null};
        if (canStore) { try { localStorage.removeItem(SESSION_KEY); } catch(e){} }
      }
      initCustomer(s);
      showView('vCustomer');
    }
  });

  // Wire audio unlock button
  const unlockBtn = $('audioUnlockBtn');
  if (unlockBtn) {
    unlockBtn.addEventListener('click', async () => {
      playNotificationSound(); // Plays silent chime to unlock browser audio policy
      if ('Notification' in window) {
        try {
          const perm = await Notification.requestPermission();
          console.log("Audio unlock notification permission status:", perm);
          if (perm === 'granted' && typeof initPushNotifications === 'function') {
            await initPushNotifications();
          }
        } catch(e) {
          console.error("Failed requesting permission inside unlock click:", e);
        }
      }
      const banner = $('audioUnlockBanner');
      if (banner) banner.style.display = 'none';
    });
  }

  // Wire push-notifications banner button (owner dashboard).
  // The permission request MUST happen right here, inside the click handler:
  // initPushNotifications() deliberately never asks (Safari/iOS auto-denies
  // permission requests made outside a user gesture).
  const pushBtn = $('pushNotifBtn');
  if (pushBtn) {
    pushBtn.addEventListener('click', async () => {
      pushBtn.textContent = '…';
      if ('Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch(e) {}
      }
      await initPushNotifications();
      await renderPushNotifBanner();
    });
  }

  // Wire customer 24h-reminder opt-in button (booking confirmation screen)
  const custReminderBtn = $('custReminderBtn');
  if (custReminderBtn) {
    custReminderBtn.addEventListener('click', async () => {
      if (!lastBookingId) return;
      custReminderBtn.disabled = true;
      custReminderBtn.textContent = '…';
      const ok = await initCustomerPushNotifications(lastBookingId);
      if (ok) {
        $('custReminderIcon').textContent = '✅';
        $('custReminderMsg').textContent = 'Promemoria attivato! Ti avviseremo 24h prima.';
        custReminderBtn.style.display = 'none';
      } else {
        custReminderBtn.disabled = false;
        custReminderBtn.textContent = 'Attiva';
        $('custReminderMsg').textContent = 'Impossibile attivare il promemoria su questo dispositivo.';
      }
    });
  }

  // Wire owner sidebar QR code button
  const qrBtnEl = $('sideQrBtn');
  if (qrBtnEl) {
    qrBtnEl.addEventListener('click', () => {
      const salon = getSalon();
      if (salon) showSalonQRCode(salon.slug);
    });
  }

  updateNavMenu();
  findNearestSalons();

  // Check initial hash or restore active session on startup!
  const checkInitialHash = async () => {
    loadSession();

    // 1a. Admin dashboard deep-link (#admin/saloni, #admin/stats, ...) — only
    // meaningful with an active admin session (e.g. a page refresh); falls
    // back to the login screen otherwise.
    const rawHash = (location.hash || '').replace('#', '');
    if (rawHash.startsWith('admin/')) {
      if (SESSION && SESSION.role === 'admin') {
        handleAdminHashRoute(rawHash);
      } else {
        location.hash = '';
        showView('vLogin');
      }
      return;
    }

    // 1b. Prioritize hash check: if there is a hash pointing to a valid salon, show that salon's customer page
    const h = rawHash.toUpperCase().trim();
    if (h) {
      let s = STATE.salons.find(x => x.slug === h);
      if (!s && initialCloudSync) {
        // A freshly installed PWA has empty localStorage: salons created only
        // in the cloud aren't known yet. Wait for the first sync (max 8s)
        // before concluding the slug is invalid, or the customer would be
        // dumped on the login screen.
        await Promise.race([initialCloudSync, new Promise(r => setTimeout(r, 8000))]);
        s = STATE.salons.find(x => x.slug === h);
      }
      if (s) {
        if (s.inactive) {
          alert(`Spiacenti, il salone "${s.name}" è temporaneamente inattivo. Contatta l'amministratore.`);
          location.hash = '';
          SESSION = {role:null,salonId:null,workerId:null,name:null};
          if (canStore) { try { localStorage.removeItem(SESSION_KEY); } catch(e){} }
          showView('vLogin');
          return;
        }
        // An owner/barber of THIS salon re-opening their own salon's QR link
        // must stay logged in and land on their dashboard — re-scanning the
        // QR code is how staff get back into the app from the Home Screen,
        // it must never log them out.
        if (SESSION && (SESSION.role === 'owner' || SESSION.role === 'barber') && SESSION.salonId === s.id) {
          showView('vDash');
          initDash();
          if (typeof initPushNotifications === 'function') initPushNotifications();
          return;
        }
        // A staff session belonging to a DIFFERENT salon doesn't apply here —
        // clear it so the visitor gets a clean customer page for the scanned
        // salon. Admin sessions survive (same rule as the hashchange handler:
        // an admin may freely browse any salon's public page).
        if (SESSION && SESSION.role && SESSION.role !== 'admin') {
          SESSION = {role:null,salonId:null,workerId:null,name:null};
          if (canStore) { try { localStorage.removeItem(SESSION_KEY); } catch(e){} }
        }
        initCustomer(s);
        showView('vCustomer');
        return;
      }
    }

    // 2. If no valid salon hash, check and restore active session
    if (SESSION && SESSION.role) {
      // If owner or barber, check if salon is still active
      if (SESSION.role !== 'admin' && SESSION.salonId) {
        let s = STATE.salons.find(x => x.id === SESSION.salonId);
        if (!s && initialCloudSync) {
          // The salon isn't in the local snapshot yet — could just be a fresh
          // install/origin still waiting on its first cloud sync. Give it a
          // chance before treating this staff session as orphaned, otherwise
          // an owner/barber reopening the app can briefly fall through to a
          // salon-less dashboard that renders with the generic "Admin"
          // sidebar label — the exact admin/salon mix-up this guards against.
          await Promise.race([initialCloudSync, new Promise(r => setTimeout(r, 8000))]);
          s = STATE.salons.find(x => x.id === SESSION.salonId);
        }
        if (!s) {
          // RULE: a non-admin session with no matching salon must NEVER fall
          // through to a rendered dashboard (it would show as an unlabeled/
          // admin-looking page). Log out cleanly instead — staff/owner pages
          // and the admin page must never be conflated.
          SESSION = {role:null,salonId:null,workerId:null,name:null};
          if (canStore) {
            try { localStorage.removeItem(SESSION_KEY); } catch(e){}
          }
          alert(`Il tuo salone non è stato trovato. Effettua nuovamente l'accesso dalla pagina del tuo salone.`);
        } else if (s.inactive) {
          SESSION = {role:null,salonId:null,workerId:null,name:null};
          if (canStore) {
            try { localStorage.removeItem(SESSION_KEY); } catch(e){}
          }
          alert(`Questo salone è stato disattivato dall'amministratore. Accesso negato.`);
        } else {
          // Valid active session - route straight to dashboard!
          showView('vDash');
          initDash();
          if (typeof initPushNotifications === 'function') {
            initPushNotifications();
          }
          return;
        }
      } else {
        // Admin session exists, but a bare root visit must always land on
        // the informative/marketing entry point first — never silently
        // restore straight to the salon-management homepage just because a
        // token is still valid. showView('vLogin') detects the still-valid
        // admin session itself and swaps the login form for a one-click
        // "already signed in" shortcut, so this doesn't force a real
        // re-login, just an explicit confirmation step.
        loginSalonContext = null;
        loginRoleContext = null;
        showView('vLogin');
        return;
      }
    }

    // 3. No hash, no session — a Home-Screen/PWA launch strips the #SLUG
    // hash, so restore the last salon page the customer visited instead of
    // stranding them on the login screen. Only in standalone (installed)
    // mode: a regular browser tab keeps its hash by itself, and the bare
    // root URL must stay reachable there as the admin entry point.
    const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    if (canStore && isStandalone) {
      try {
        const lastSlug = localStorage.getItem('trimio_last_salon_slug');
        if (lastSlug) {
          let s = STATE.salons.find(x => x.slug === lastSlug && !x.inactive);
          if (!s && initialCloudSync) {
            await Promise.race([initialCloudSync, new Promise(r => setTimeout(r, 8000))]);
            s = STATE.salons.find(x => x.slug === lastSlug && !x.inactive);
          }
          if (s) {
            location.hash = '#' + s.slug;
            initCustomer(s);
            showView('vCustomer');
            return;
          }
        }
      } catch(e) {}
    }

    // 4. Nothing to restore -> show login
    showView('vLogin');
  };
  await checkInitialHash();
  updateManifestLink();
}

// Expose internal functions globally on window to support inline HTML onclick handlers in type="module" mode
window.closeModal = closeModal;
window.selectReviewStar = selectReviewStar;
window.dashAction = dashAction;
window.showBarberReviews = showBarberReviews;
window.openWorkerModal = openWorkerModal;
window.openBreakModal = openBreakModal;
window.deleteSalonModalWorker = deleteSalonModalWorker;
window.onHeaderLogoClick = onHeaderLogoClick;

boot();