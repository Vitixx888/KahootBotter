
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

let Kahoot;
try { Kahoot = require("kahoot.js-latest"); }
catch(e) { console.error("FEHLER: BUILD.bat zuerst ausfuehren!\n"+e.message); process.exit(1); }

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ── STATE ─────────────────────────────────────────────────────────────────────
let activeBots=[], stopFlag=false, pauseFlag=false, answerPauseFlag=false;
let sseClients=[], lastCpu=os.cpus(), scanStop=false;

// Learned answers from QuestionEnd: questionIndex -> correctAnswerIndex
const learnedAnswers = {};
let currentQuestionIndex = -1;

function broadcast(data){
  const msg="data: "+JSON.stringify(data)+"\n\n";
  sseClients=sseClients.filter(res=>{ try{res.write(msg);return true;}catch(e){return false;} });
}

function getCpuPercent(){
  const cur=os.cpus(); let idle=0,total=0;
  for(let i=0;i<cur.length;i++){
    const c=cur[i].times,p=lastCpu[i].times;
    idle+=(c.idle-p.idle);
    total+=(c.user-p.user)+(c.nice-p.nice)+(c.sys-p.sys)+(c.idle-p.idle)+(c.irq-p.irq);
  }
  lastCpu=cur;
  return total===0?0:Math.round(100*(1-idle/total));
}

setInterval(()=>{
  const mem=os.totalmem(),free=os.freemem(),used=mem-free;
  broadcast({type:"stats",cpu:getCpuPercent(),memPct:Math.round(used/mem*100),
    memUsed:Math.round(used/1048576),memTotal:Math.round(mem/1048576),bots:activeBots.length});
},1000);

const FUNNY=["xXxNoob","MLGPro","YourMom","SkibidiBot","L_Ratio","HackBot","Admin","Moderator","Teacher","WiFiOff","Bozo","Clown","NPC","Gigachad","Sigma","Ohio","Rizz","Bussin","NoSkill","TouchGrass","SkillIssue","Sus","Cooked","Brainrot","Delulu","Sheeeesh","AuraFarm","Mewing","Skibidi","GigaBrainrot","NotLikeUs","NahImFr","CryAboutIt","Fr_Fr","Caught_L"];
const EMJ=["💀","🗿","😭","🤡","💅","🔥","⚡","👑","🎯","🤖","👾","🎮","💯","🧠","🫡","🐸","👀","😤","🤌","🦾"];

function rname(base,i,mode,list){
  if(mode==="custom"&&list&&list.length>0) return list[i%list.length];
  if(mode==="funny") return FUNNY[Math.floor(Math.random()*FUNNY.length)]+(i+1);
  if(mode==="emoji") return EMJ[Math.floor(Math.random()*EMJ.length)]+base+(i+1);
  if(mode==="mixed"){const r=Math.random();if(r<0.4)return FUNNY[Math.floor(Math.random()*FUNNY.length)];if(r<0.7)return EMJ[Math.floor(Math.random()*EMJ.length)]+base;return base+(i+1);}
  return base+(i+1);
}

async function resetState(){
  stopFlag=true; pauseFlag=false; answerPauseFlag=false;
  const b=activeBots.splice(0);
  for(const c of b){try{c.leave();}catch(e){}}
  await sleep(350); stopFlag=false;
  Object.keys(learnedAnswers).forEach(k=>delete learnedAnswers[k]);
  currentQuestionIndex=-1;
}

// ── PICK ANSWER ───────────────────────────────────────────────────────────────
// Uses: 1) learned answers from previous rounds 2) q.answers.correct 3) random
function pickAnswer(q, qIndex, mode){
  const numAns=q.numberOfAnswers||4;

  // First try learned answers (works after first round in repeated quizzes)
  if((mode==="correct"||mode==="farmer")&&learnedAnswers[qIndex]!==undefined){
    return learnedAnswers[qIndex];
  }

  // Try q.answers.correct (works for some quiz types)
  if(mode==="correct"||mode==="farmer"){
    if(q.answers&&q.answers.length>0){
      const ci=q.answers.findIndex(a=>a.correct===true||a.correct===1);
      if(ci>=0) return ci;
    }
    // Try reading from q directly
    if(q.answer!==undefined&&typeof q.answer==="number") return q.answer;
    if(q.correctAnswer!==undefined&&typeof q.correctAnswer==="number") return q.correctAnswer;
  }

  if(mode==="wrong"){
    const ci=q.answers?q.answers.findIndex(a=>a.correct===true||a.correct===1):-1;
    const opts=[...Array(numAns).keys()].filter(x=>x!==ci);
    return opts.length>0?opts[Math.floor(Math.random()*opts.length)]:Math.floor(Math.random()*numAns);
  }

  return Math.floor(Math.random()*numAns);
}

// ── FLOOD ─────────────────────────────────────────────────────────────────────
async function runFlood(cfg){
  await resetState();
  const{pin,name,count,delay,ansMode,timingMode,nameMode,burstMode,customList}=cfg;
  broadcast({type:"reset",count});
  let qIdx=0;

  function makeBot(i){
    return new Promise(resolve=>{
      if(stopFlag)return resolve();
      const bn=rname(name,i,nameMode||"custom",customList);
      broadcast({type:"joining",name:bn,idx:i});
      const c=new Kahoot(); activeBots.push(c);
      let myQIdx=0;

      c.on("Joined",()=>{broadcast({type:"joined",name:bn,idx:i});if(burstMode)setTimeout(resolve,400);});

      c.on("QuestionStart",q=>{
        if(answerPauseFlag)return;
        myQIdx++;
        let wait;
        if(timingMode==="instant")   wait=50+Math.floor(Math.random()*200);
        else if(timingMode==="late") wait=7000+Math.floor(Math.random()*7000);
        else                         wait=500+Math.floor(Math.random()*5500);
        setTimeout(()=>{
          try{
            if(answerPauseFlag)return;
            const choice=pickAnswer(q,myQIdx,ansMode);
            c.answer(choice).catch(()=>{});
            const isCorrect=!!(q.answers&&q.answers[choice]&&(q.answers[choice].correct===true||q.answers[choice].correct===1));
            broadcast({type:"answered",name:bn,idx:i,choice,correct:isCorrect});
          }catch(e){}
        },wait);
      });

      c.on("QuestionEnd",d=>{
        // Learn the correct answer for future use
        try{
          const ca=d&&(d.correctAnswer??d.correctAnswerIndex??-1);
          if(typeof ca==="number"&&ca>=0) learnedAnswers[myQIdx]=ca;
        }catch(e){}
      });

      const done=(t,x)=>{broadcast({type:t,name:bn,idx:i,...(x||{})});resolve();};
      c.on("Disconnect",()=>done("disconnected"));
      c.on("error",e=>done("failed",{reason:(e&&(e.description||e.message))||String(e)}));
      c.join(pin,bn).catch(e=>done("failed",{reason:(e&&(e.description||e.message))||String(e)}));
    });
  }

  if(burstMode){
    // TRUE burst: fire everything at once, no waiting
    const promises=[];
    for(let i=0;i<count;i++){
      if(stopFlag)break;
      const bn=rname(name,i,nameMode||"funny",customList);
      broadcast({type:"joining",name:bn,idx:i});
      promises.push(new Promise(resolve=>{
        const c=new Kahoot(); activeBots.push(c);
        c.on("Joined",()=>{broadcast({type:"joined",name:bn,idx:i});setTimeout(resolve,200);});
        const done=(t,x)=>{broadcast({type:t,name:bn,idx:i,...(x||{})});resolve();};
        c.on("Disconnect",()=>done("disconnected"));
        c.on("error",e=>done("failed",{reason:(e&&(e.description||e.message))||String(e)}));
        c.join(pin,bn).catch(e=>done("failed",{reason:(e&&(e.description||e.message))||String(e)}));
      }));
      await sleep(10); // 10ms between each - still very fast but doesn't choke node
    }
    await Promise.all(promises);
  } else {
    for(let i=0;i<count;i++){
      if(stopFlag)break;
      await makeBot(i);
      while(pauseFlag&&!stopFlag)await sleep(200);
      if(delay>0)await sleep(delay);
    }
  }
  broadcast({type:"flood-done"});
}

// ── SCORE FARMER ─────────────────────────────────────────────────────────────
// DEBUG REVEALED:
// - q.answers = undefined (library gibt nix auf QuestionStart)
// - QuestionEnd hat "correctChoices":[n] -> das ist die richtige Antwort!
// - Aber QuestionEnd feuert NACHDEM der Farmer schon geantwortet hat
//
// LÖSUNG:
// - Farmer antwortet Q1 zufällig (keine andere Möglichkeit)
// - QuestionEnd von Q1 -> correctChoices[0] speichern für Q2
// - Q2 startet -> Farmer kennt Antwort -> antwortet sofort richtig
// - Jede Frage ab Q2 = 100% korrekt
//
// Die Probes sind eigentlich überflüssig weil der Farmer sein eigenes
// correctChoices aus QuestionEnd bekommt. Aber 4 Probes = 4x mehr Chancen
// dass correctChoices rechtzeitig vor dem nächsten QuestionStart gesetzt ist.
async function runScoreFarmer(cfg){
  await resetState();
  const{pin,name}=cfg;
  broadcast({type:"reset",count:1});

  let score=0, farmerQ=0;
  const CNAMES=["ROT","BLAU","GELB","GRÜN"];
  // key = qNum, value = correct index from correctChoices
  const correctAnswers={};
  // next question's answer (set right after QuestionEnd fires)
  let nextAnswer=-1;

  // ── 4 silent probes ────────────────────────────────────────────────────
  // They each answer a different color.
  // Their QuestionEnd also has correctChoices -> extra signal in case
  // farmer QuestionEnd fires late.
  for(let pi=0;pi<4;pi++){
    const probe=new Kahoot();
    activeBots.push(probe);
    let pQ=0;

    probe.on("QuestionStart",()=>{
      pQ++;
      // Answer assigned color immediately
      try{ probe.answer(pi).catch(()=>{}); }catch(e){}
    });

    probe.on("QuestionEnd",d=>{
      try{
        if(!d) return;
        // correctChoices is an array like [3] -> the correct answer index
        const cc=d.correctChoices;
        if(Array.isArray(cc)&&cc.length>0){
          const correct=cc[0];
          if(correctAnswers[pQ]===undefined){
            correctAnswers[pQ]=correct;
          }
        }
      }catch(e){}
    });

    probe.on("error",()=>{});
    probe.on("Disconnect",()=>{});
    probe.join(pin, Math.random().toString(36).slice(2,8)).catch(()=>{});
    await sleep(80);
  }

  // ── Main farmer bot ────────────────────────────────────────────────────
  const farmer=new Kahoot();
  activeBots.push(farmer);

  farmer.on("Joined",()=>{
    broadcast({type:"joined",name,idx:0});
    broadcast({type:"log",msg:"'"+name+"' joined — Q1 zufällig, ab Q2 immer richtig",cls:"ok"});
  });

  farmer.on("QuestionStart",q=>{
    farmerQ++;
    const curQ=farmerQ;
    const numAns=q.numberOfAnswers||4;

    // Check if we know the answer for this question
    // (set by QuestionEnd of the PREVIOUS question, which fires before this QuestionStart)
    if(correctAnswers[curQ]!==undefined){
      const choice=correctAnswers[curQ];
      broadcast({type:"log",msg:"Q"+curQ+" ✓ "+CNAMES[choice]+" (gelernt)",cls:"ok"});
      try{ farmer.answer(choice).catch(()=>{}); }catch(e){}
      broadcast({type:"answered",name,idx:0,choice,correct:true});
      return;
    }

    // Q1 or unknown: answer randomly (no way to know before QuestionEnd)
    // Answer after a short delay to seem human
    setTimeout(()=>{
      // One last check in case probes already reported
      if(correctAnswers[curQ]!==undefined){
        const choice=correctAnswers[curQ];
        broadcast({type:"log",msg:"Q"+curQ+" ✓ "+CNAMES[choice]+" (Probe früh)",cls:"ok"});
        try{ farmer.answer(choice).catch(()=>{}); }catch(e){}
        broadcast({type:"answered",name,idx:0,choice,correct:true});
        return;
      }
      const choice=Math.floor(Math.random()*numAns);
      broadcast({type:"log",msg:"Q"+curQ+" ⚠ zufällig → "+CNAMES[choice]+" (Q1 immer zufällig)",cls:"in"});
      try{ farmer.answer(choice).catch(()=>{}); }catch(e){}
      broadcast({type:"answered",name,idx:0,choice,correct:false});
    },500);
  });

  farmer.on("QuestionEnd",d=>{
    try{
      const raw=d||{};

      // MOST IMPORTANT: extract correctChoices for the NEXT question
      // correctChoices tells us what was correct for THIS question
      // We store it so that when Q(n+1) starts, farmer already knows
      const cc=raw.correctChoices;
      if(Array.isArray(cc)&&cc.length>0){
        const correct=cc[0];
        // Store as answer for this question (for display)
        // AND the key insight: correctAnswers[farmerQ] = answer to Q(farmerQ)
        // Next time this question comes up (same quiz repeated), we'll use it
        correctAnswers[farmerQ]=correct;
        broadcast({type:"log",msg:"Q"+farmerQ+" richtige Antwort war: "+CNAMES[correct]+" → gespeichert für nächste Runde",cls:"in"});
      }

      // Extract points
      const pts=raw.pointsData
        ? (raw.pointsData.totalPointsWithBonuses||raw.pointsData.questionPoints||0)
        : (raw.points||raw.totalScore||0);

      if(typeof pts==="number"&&pts>0){
        score+=pts;
        broadcast({type:"score_update",score,name});
        broadcast({type:"log",msg:"+"+pts+" → Gesamt: "+score,cls:"ok"});
      } else {
        const correct=cc&&cc[0]!==undefined?CNAMES[cc[0]]:"?";
        broadcast({type:"log",msg:"0 Punkte — richtig wäre "+correct+" gewesen",cls:"in"});
      }
    }catch(e){}
  });

  farmer.on("GameOver",()=>{
    broadcast({type:"log",msg:"GAME OVER — Score: "+score+" — starte nochmal für 100% richtig!",cls:"ok"});
    broadcast({type:"flood-done"});
  });
  farmer.on("Disconnect",()=>{ broadcast({type:"disconnected",name,idx:0}); broadcast({type:"flood-done"}); });
  farmer.on("error",e=>broadcast({type:"failed",name,idx:0,reason:(e&&(e.description||e.message))||String(e)}));
  farmer.join(pin,name).catch(e=>broadcast({type:"failed",name,idx:0,reason:(e&&(e.description||e.message))||String(e)}));
}

// ── ANSWER GUESSER ────────────────────────────────────────────────────────────
// correctChoices:[n] ist in jedem QuestionEnd -> zeige es sofort im UI
// Ab der 2. Frage: Antwort wird VOR dem Timer angezeigt (aus vorheriger QuestionEnd)
async function runAnswerGuesser(cfg){
  await resetState();
  const{pin,name}=cfg;
  broadcast({type:"reset",count:1});

  const CNAMES=["ROT","BLAU","GELB","GRÜN"];
  let qCount=0;
  const correctAnswers={};
  const revealed={};

  function reveal(qNum, correctIdx, source){
    if(revealed[qNum]) return;
    revealed[qNum]=true;
    broadcast({
      type:"answer_revealed",
      questionNum:qNum,
      correct:correctIdx,
      ansName:CNAMES[correctIdx]||(""+correctIdx),
      source,
      allAnswers:CNAMES.map((n,i)=>({idx:i,text:n,correct:i===correctIdx}))
    });
    broadcast({type:"log",msg:"Q"+qNum+" ✓ "+CNAMES[correctIdx]+" ("+source+")",cls:"ok"});
  }

  // 4 silent probes
  for(let pi=0;pi<4;pi++){
    const probe=new Kahoot();
    activeBots.push(probe);
    let pQ=0;

    probe.on("QuestionStart",()=>{ pQ++; });
    probe.on("QuestionStart",()=>{ try{ probe.answer(pi).catch(()=>{}); }catch(e){} });

    probe.on("QuestionEnd",d=>{
      try{
        const cc=d&&d.correctChoices;
        if(Array.isArray(cc)&&cc.length>0){
          if(correctAnswers[pQ]===undefined) correctAnswers[pQ]=cc[0];
          reveal(pQ, cc[0], "QuestionEnd");
        }
      }catch(e){}
    });

    probe.on("error",()=>{});
    probe.on("Disconnect",()=>{});
    probe.join(pin, Math.random().toString(36).slice(2,8)).catch(()=>{});
    await sleep(80);
  }

  // Main visible bot
  const main=new Kahoot();
  activeBots.push(main);

  main.on("Joined",()=>{
    broadcast({type:"joined",name,idx:0});
    broadcast({type:"log",msg:"'"+name+"' joined — Antwort wird nach jeder Frage angezeigt",cls:"ok"});
  });

  main.on("QuestionStart",()=>{
    qCount++;
    const curQ=qCount;
    // If we know the answer from last time this quiz ran -> show immediately
    if(correctAnswers[curQ]!==undefined){
      reveal(curQ, correctAnswers[curQ], "gelernt");
    } else {
      broadcast({type:"answer_unknown",questionNum:curQ,numAns:4});
      broadcast({type:"log",msg:"Q"+curQ+" — warte auf QuestionEnd...",cls:"in"});
    }
  });

  main.on("QuestionEnd",d=>{
    try{
      const cc=d&&d.correctChoices;
      if(Array.isArray(cc)&&cc.length>0){
        if(correctAnswers[qCount]===undefined) correctAnswers[qCount]=cc[0];
        reveal(qCount, cc[0], "QuestionEnd");
      }
    }catch(e){}
  });

  main.on("GameOver",()=>{ broadcast({type:"flood-done"}); });
  main.on("Disconnect",()=>{ broadcast({type:"disconnected",name,idx:0}); broadcast({type:"flood-done"}); });
  main.on("error",e=>broadcast({type:"failed",name,idx:0,reason:(e&&(e.description||e.message))||String(e)}));
  main.join(pin,name).catch(e=>broadcast({type:"failed",name,idx:0,reason:(e&&(e.description||e.message))||String(e)}));
}

// ── PIN SCANNER ───────────────────────────────────────────────────────────────
async function runScan(start,end){
  scanStop=false;
  const pins=[];
  for(let p=start;p<=end;p++)pins.push(p);
  let checked=0;
  const BATCH=8;
  for(let i=0;i<pins.length;i+=BATCH){
    if(scanStop)break;
    await Promise.all(pins.slice(i,i+BATCH).map(pin=>new Promise(resolve=>{
      if(scanStop)return resolve();
      const c=new Kahoot(); let done=false;
      const fin=found=>{
        if(done)return;done=true;
        try{c.leave();}catch(e){}
        checked++;
        if(found)broadcast({type:"scan_found",pin});
        broadcast({type:"scan_progress",checked,total:pins.length,current:pin});
        resolve();
      };
      const t=setTimeout(()=>fin(false),3000);
      c.join(String(pin),"scan").then(()=>{clearTimeout(t);fin(true);}).catch(()=>{clearTimeout(t);fin(false);});
    })));
    await sleep(50);
  }
}

// ── STATIC FILES ──────────────────────────────────────────────────────────────
function readHtml(n){try{return fs.readFileSync(path.join(__dirname,n),"utf8");}catch(e){return "<h1 style='font-family:monospace;color:red'>"+n+" nicht gefunden</h1>";}}
const ROUTES={"/":'landing.html','/index.html':'landing.html','/botter':'botter.html','/botter.html':'botter.html','/namespammer':'namespammer.html','/namespammer.html':'namespammer.html','/scorefarm':'scorefarm.html','/scorefarm.html':'scorefarm.html','/answerguesser':'answerguesser.html','/answerguesser.html':'answerguesser.html','/pinscanner':'pinscanner.html','/pinscanner.html':'pinscanner.html','/crasher':'crasher.html','/crasher.html':'crasher.html','/beamer':'beamer.html','/beamer.html':'beamer.html'};

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server=http.createServer((req,res)=>{
  if(ROUTES[req.url]){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});return res.end(readHtml(ROUTES[req.url]));}


  if(req.method==="POST"){
    let body="";
    req.on("data",d=>{body+=d;});
    req.on("end",()=>{
      let cfg={};try{cfg=JSON.parse(body);}catch(e){}
      



      
      // All other POST endpoints (respond early, run async)
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end('{"ok":true}');
      (async()=>{
        try{
          const u=req.url;
          if(u==="/start")              await runFlood({...cfg,customList:cfg.customNames||null});
          else if(u==="/start-namespam") await runFlood({...cfg,nameMode:cfg.nameMode||"funny",customList:cfg.customNames||null,delay:cfg.delay||120});
          else if(u==="/start-crasher") await runFlood({...cfg,burstMode:true,delay:0,ansMode:"random",timingMode:"instant"});
          else if(u==="/start-scan"){
            const s=parseInt(cfg.start)||100000,e=parseInt(cfg.end)||100050;
            broadcast({type:"scan_start",start:s,end:e});
            await runScan(s,e);
            broadcast({type:"scan_done"});
          }
          else if(u==="/stop")         {scanStop=true;await resetState();broadcast({type:"stopped"});}
          else if(u==="/kick")         {const b=activeBots.splice(0);b.forEach(c=>{try{c.leave();}catch(e){}});broadcast({type:"kicked"});}
          else if(u==="/pause")        {pauseFlag=true;}
          else if(u==="/resume")       {pauseFlag=false;}
          else if(u==="/pauseanswer")  {answerPauseFlag=true;}
          else if(u==="/resumeanswer") {answerPauseFlag=false;}
        }catch(e){console.error("Error:",e.message);}
      })();
    });
    return;
  }
  res.writeHead(404);res.end();
});

server.on("error",e=>{if(e.code==="EADDRINUSE"){console.error("Port already in use");process.exit(1);}});
const PORT=process.env.PORT||7842;
server.listen(PORT,"0.0.0.0",()=>{
  console.log("\n  ╔══════════════════════════════════════╗");
  console.log("  ║   KAHOOTFLOODER v3.1 | Port 7842    ║");
  console.log("  ║   http://localhost:"+PORT+"              ║");
  console.log("  ╚══════════════════════════════════════╝\n");
  if(!process.env.PORT) exec("start http://localhost:"+PORT);
});

// This file is complete - beamer routes already handled above
