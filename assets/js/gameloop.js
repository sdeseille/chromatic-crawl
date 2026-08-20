let { init, TileEngine, Sprite, GameLoop, initKeys, initPointer, keyPressed, onKey, Text, Grid, track, clamp, collides } = kontra;

let // ZzFXMicro - Zuper Zmall Zound Zynth - v1.3.1 by Frank Force ~ 1000 bytes
zzfxV=.3,               // volume
zzfxX=new AudioContext, // audio context
zzfx=                   // play sound
(p=1,k=.05,b=220,e=0,r=0,t=.1,q=0,D=1,u=0,y=0,v=0,z=0,l=0,E=0,A=0,F=0,c=0,w=1,m=0,B=0
,N=0)=>{let M=Math,d=2*M.PI,R=44100,G=u*=500*d/R/R,C=b*=(1-k+2*k*M.random(k=[]))*d/R,
g=0,H=0,a=0,n=1,I=0,J=0,f=0,h=N<0?-1:1,x=d*h*N*2/R,L=M.cos(x),Z=M.sin,K=Z(x)/4,O=1+K,
X=-2*L/O,Y=(1-K)/O,P=(1+h*L)/2/O,Q=-(h+L)/O,S=P,T=0,U=0,V=0,W=0;e=R*e+9;m*=R;r*=R;t*=
R;c*=R;y*=500*d/R**3;A*=d/R;v*=d/R;z*=R;l=R*l|0;p*=zzfxV;for(h=e+m+r+t+c|0;a<h;k[a++]
=f*p)++J%(100*F|0)||(f=q?1<q?2<q?3<q?Z(g**3):M.max(M.min(M.tan(g),1),-1):1-(2*g/d%2+2
)%2:1-4*M.abs(M.round(g/d)-g/d):Z(g),f=(l?1-B+B*Z(d*a/l):1)*(f<0?-1:1)*M.abs(f)**D*(a
<e?a/e:a<e+m?1-(a-e)/m*(1-w):a<e+m+r?w:a<h-c?(h-a-c)/t*w:0),f=c?f/2+(c>a?0:(a<h-c?1:(
h-a)/c)*k[a-c|0]/2/p):f,N?f=W=S*T+Q*(T=U)+P*(U=f)-Y*V-X*(V=W):0),x=(b+=u+=y)*M.cos(A*
H++),g+=x+x*E*Z(a**5),n&&++n>z&&(b+=v,C+=v,n=0),!l||++I%l||(b=C,u=G,n=n||1);p=zzfxX.
createBuffer(1,h,R);p.getChannelData(0).set(k);b=zzfxX.createBufferSource();
b.buffer=p;b.connect(zzfxX.destination);b.start()}


// --- Litlle sound engine ---
function playSound(type){
  switch(type){
    case "jump": 
      zzfx(...[.7,,177,.01,.02,.05,,.1,,35,,,,,,,,.81,.02,,146]);
      break;
    case "rebound":
      zzfx(...[2.1,,358,.02,.01,.17,4,3.6,,,,,,.6,15,.4,.17,.75,.06]);
      break;
    case "dash":
      zzfx(...[,,400,.05,.15,.2,,2]);
      break;
    case "squash":
      zzfx(...[,,60,.2,.3,.4,2]);
      break;
    case "pickup":
      zzfx(...[1.5,,539,,,.06,,.8,,,,,,.1,,,,.65]);
      break;
    case "catStep1":
      // a light, soft step
      zzfx(...[,,120,.01,.02,.02,1,1.5,,.5]); 
      break;
    case "catStep2":
      // a more subdued variant, slightly higher in pitch
      zzfx(...[,,160,.01,.015,.02,1,1.2,,.6]); 
      break;

  }
}

const { canvas } = init();
initPointer();
initKeys();

// ------------ CONSTANT ------------
const bold_font = 'bold 20px Arial, sans-serif';
const normal_font = '20px Arial, sans-serif';
const text_options = {
  color: 'white',
  font: normal_font
};

// ------------ Global ------------
let tileEngine = [];
let MAX_HIGH_SCORES = 5;
let game_level = 1;
let game_state = 1; // 'menu' = 1, 'play' = 2, 'gameover' = 3, 'gamewon' = 4, 'highscores' = 5
let player_score = 0;
let player_name = '';
let is_name_entered = false;
let current_level = 1;

// ------------ functions toolbox ------------
function dist(a,b){ let dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }

function is_last_level(level){ return level == number_of_levels;}

onKey('r', function(e) {
  // return to the game menu
  console.log("r key pressed ! ");
  game_state = 1;
  initGame('restart',current_level);
});

function get_highscores() {
  // Retrieve scores from localStorage or return an empty array if not present
  return JSON.parse(localStorage.getItem('chromatic_crawl_highscores')) || [];
}

function save_highscore(new_score, player_name) {
  let highscores = get_highscores();
  const new_highscore = { score: new_score, name: player_name };

  // Add new score and sort the array in descending order
  highscores.push(new_highscore);
  highscores.sort((a, b) => b.score - a.score);

  // Limit the array to top MAX_HIGH_SCORES scores
  highscores.splice(MAX_HIGH_SCORES);

  // Save back to localStorage
  localStorage.setItem('chromatic_crawl_highscores', JSON.stringify(highscores));
}

function mk_cell(text, x, y, font = normal_font) {
  return Text({
    text: text,
    font: font,
    color: 'white',
    x: x,
    y: y,
    anchor: {x: 0.5, y: 0.5},
    textAlign: 'center'
  });
}

function generate_score_table(highscores) {
  let text_objects = [];
  let start_y = 160; // Starting Y position for the first row
  let row_height = 40; // Space between each row
  let last_y_pos = start_y; // Used by text message proposing to restart a game

  // Column x positions for rank, name, and score
  const nameX = canvas.width/2;
  const rankX = nameX-100;
  const scoreX = nameX+100;

  // Header row
  text_objects.push(mk_cell('Rank',rankX,start_y - 40));
  text_objects.push(mk_cell('Name',nameX,start_y - 40));
  text_objects.push(mk_cell('Score',scoreX,start_y - 40));

  // Loop through high scores and create Text objects for each entry
  highscores.forEach((entry, index) => {
    let y_pos = start_y + (index * row_height);
    last_y_pos = y_pos;

    text_objects.push(mk_cell(`${index + 1}`.padStart(3,'0'),rankX,y_pos));  // Rank
    text_objects.push(mk_cell(entry.name,nameX,y_pos));  // Player Name
    text_objects.push(mk_cell(entry.score.toString().padStart(3,'0'),scoreX,y_pos));  // Player Score
  });

  // Add a message to restart a game
  text_objects.push(mk_cell('Press [r] to restart',canvas.width/2,last_y_pos + (row_height * 1.5),bold_font));

  return text_objects;
}

function new_banner(msg, colorname) {
  return Text({
    text: msg,
    font: '54px Arial',
    color: colorname,
    x: canvas.width/2,
    y: 75,
    anchor: {x: 0.5, y: 0.5},
    textAlign: 'center'
  });
}

let game_title = new_banner('🌈 Chromatic Crawl 🦄', 'yellow');
let highscores_title = new_banner('🏆 -= Highscore =- 🏆', 'gold');

let game_over = Text({
  text: 'Game Over\n\nYour score: ' + player_score,
  font: 'italic 58px Arial',
  color: 'red',
  x: canvas.width/2,
  y: 100,
  anchor: {x: 0.5, y: 0.5},
  textAlign: 'center',
  update: function () {
    this.text = 'Game Over\nYour score: ' + player_score
  }
});

let game_won = Text({
  text: '🎉Congratulation🎉\n\nYour score: ' + player_score,
  font: 'italic 58px Arial',
  color: 'white',
  x: canvas.width/2,
  y: 100,
  anchor: {x: 0.5, y: 0.5},
  textAlign: 'center',
  update: function () {
    this.text = '🎉Congratulation🎉\nYour score: ' + player_score
  }
});

let start_again = Text({
  text: 'Press [r] to restart',
  font: 'bold 16px Arial',
  color: 'white',
  x: canvas.width/2,
  y: 225,
  anchor: {x: 0.5, y: 0.5},
  textAlign: 'center'
});

let start = Text({
  text: 'Start',
  onDown: function() {
    // handle on down events on the sprite
    console.log("Clicked on Start");
    game_state = 2;
    game_points_multiplier = 0;
  },
  onOver: function() {
    this.font = bold_font;
  },
  onOut: function() {
    this.font = normal_font;
  },
  ...text_options
});

let highscore = Text({
  text: 'Highscore',
  onDown: function() {
    // handle on down events on the sprite
    console.log("Clicked on High Score");
    game_state = 5;
  },
  onOver: function() {
    this.font = bold_font;
  },
  onOut: function() {
    this.font = normal_font;
  },
  ...text_options
});

let start_menu = Grid({
  x: canvas.width/2,
  y: 250,
  anchor: {x: 0.5, y: 0.5},

  // add 15 pixels of space between each row
  rowGap: 15,

  // center the children
  justify: 'center',

  children: [start, highscore]
});
track(start,highscore);

// helper to convert col/row → centered pixel coordinates
function tileToXY(col, row, tileEngine) {
  let tw = tileEngine.tilewidth;
  let th = tileEngine.tileheight;
  return {
    x: col * tw + tw/2,
    y: row * th + th/2
  };
}

// --- Main Loop ---
let scoreTable = [];
let loop = GameLoop({  // create the main game loop
  update: function() { // update the game state
    let highscores = [];
    switch (game_state) {
      case 1:
        break;
      case 2:
        break;
      case 3:
        game_over.update();
        // Check if player made a high score
        highscores = get_highscores();
        break;
      case 4:
        game_won.update();
        // Check if player made a high score
        highscores = get_highscores();
        if (highscores.length < MAX_HIGH_SCORES || player_score > highscores[highscores.length - 1].score) {
          // Player has a high score, ask for their name
          let player_name = prompt('New High Score! Enter your nickname:');
          //console.log('player_name: ['+player_name+']');
          let trimmed_player_name = player_name.substring(0, 3);
          //console.log('trimmed_player_name: ['+trimmed_player_name+']');
          save_highscore(player_score, trimmed_player_name);
          highscores = get_highscores();
          game_state='menu';
        }
        break;
      case 5:
        scoreTable = generate_score_table(get_highscores());
        break;
    }
  },
  render: function() { // render the game state
    switch (game_state) {
      case 1:
        game_title.render();
        start_menu.render();
        break;
      case 2:
        tileEngine.render();
        break;
      case 3:
        game_over.render();
        start_again.render();
        break;
      case 4:
        game_won.render();
        start_again.render();
        break;
      case 5:
        highscores_title.render()
        // Render the high score table
        scoreTable.forEach(row => row.render());
        break;
    }
  }
});

loop.start();    // start the game