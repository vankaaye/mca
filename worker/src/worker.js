/**
 * MCA Assistant — Cloudflare Worker
 *
 * Proxies the Anthropic API so the browser never sees the API key.
 *
 *   Browser widget  →  POST /chat  →  this Worker  →  api.anthropic.com
 *
 * Routes:
 *   POST /chat     conversation proxy (Claude Haiku + server-side web search)
 *   POST /enquiry  contact/callback relay → formsubmit.co → association inbox
 *   POST /hit      fire-and-forget page-view beacon (204)
 *   GET  /stats    tiny unlisted dashboard, last 14 days
 *
 * Secrets / bindings (see wrangler.toml):
 *   ANTHROPIC_API_KEY  Worker secret
 *   STATS              KV namespace for daily counters
 */

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

import ASSOCIATION_NOTES from '../knowledge.md';

const ALLOWED_ORIGINS = [
  // Primary domain
  'https://mcacric.com',
  'https://www.mcacric.com',
  // Cloudflare workers.dev address the site is served from today
  'https://mca.astrocare.workers.dev',
  // Netlify, kept so the old address keeps working while DNS moves
  'https://mcacricket.netlify.app',
  'https://www.mcacricket.netlify.app',
  'http://localhost:8000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:3000',
];

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 2048;   // detailed rule explanations + a rule-book citation
const ANTHROPIC_VERSION = '2023-06-01';

const RATE_LIMIT = 30;                  // chats per IP per rolling hour
const RATE_WINDOW_MS = 60 * 60 * 1000;

const MAX_TURNS = 12;                   // trailing conversation turns kept
const MAX_MSG_CHARS = 2000;             // per-message cap
const MAX_PAUSE_ROUNDS = 2;             // extra calls allowed for the search loop

// Attachments. Photos of a scoresheet or a PlayHQ screen are the point; the
// caps keep one oversized upload from blowing the request limit or the bill.
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;   // per file, decoded
const MAX_ATTACHMENTS_KEPT = 3;                 // most recent user turns that keep theirs


const ENQUIRY_EMAIL = 'melbournecricketassociation@gmail.com';
const STATS_TTL_SECONDS = 60 * 60 * 24 * 40; // keep daily counters ~40 days

// ----------------------------------------------------------------------------
// System prompt — personality, rules and the facts the bot may state
// ----------------------------------------------------------------------------

/**
 * The rule books, in full.
 *
 * Extracted from the two PDFs in /rules and pasted here verbatim. The
 * assistant used to work from a hand-written summary of the rule books, which
 * meant any question about a section nobody had thought to summarise came back
 * as "I don't have that" — or, worse, as an invented answer. Carrying the whole
 * text costs about 12,000 tokens per request, which prompt caching makes cheap,
 * and removes that whole class of failure.
 *
 * Re-extract with:
 *   seniors  pdftotext rules/<file>.pdf -
 *   juniors  python3 worker/tools/docx-to-text.py rules/<file>.docx
 *
 * The juniors book comes from the .docx on purpose. It is almost entirely
 * tables — one column per grade — and pdftotext flattens those into a bare
 * list of values. "Finals Qualification / Top 4 teams / Top 4 teams / Top 4
 * teams" left the model no way to tell which grade each belonged to, and it
 * guessed: it told a parent that U11 A had no finals. The docx keeps the
 * headers, so every value stays attached to its grade.
 */
const RULE_BOOK_SENIORS = `Melbourne Cricket Association

Melbourne Cricket Association (MCA)
One Day (T35) and T20 Rules – Winter 2026
Association Committee

President: Gopi Kakivai – 0430 667 896

(You may contact anyone for any queries)

Secretary: Mahendra Annem – 0433 960 586
Treasurer: Sandeep Shamala – 0433 249 914
Umpires Coordinator: Srikanth Dendi – 0430 408
093

Disputes and Complaints (within 48 hours of game
completion game)

melbournecricketassociation@gmail.com

Format

T35:
1.

35 overs per side (unless rain interrupted / wet outfield).

2.

5 overs to be played from each side before a side change.

3.

7 overs maximum for any bowler.
T20:

1.
2.

20 overs per side (unless rain interrupted / wet outfield).
The bowling team should change sides every over until the first 5 overs. And
from over 6 onwards, change sides every 5 overs until the end of the game. If
there is a reduced over game, change sides until the power play overs finished,
and then change every 5 overs. The changing sides of every over in the first 5
overs is to take advantage of the wind conditions during power play overs.

3.
Powerplay

4 overs maximum for any bowler.

T35:
Mandatory:
Bowling Power Play: First 5 overs mandatory power play.
Batting Power Play: The remaining 5 overs of power play is up to the batting team to choose.
Total 10 overs of power play in the 35 overs.
T20:
First 6 overs of mandatory power play.

Fielding
Restrictions

During Bowling Powerplay Overs: Only two fielders allowed outside inner circle
regardless of the number of fielders inside the circle. For example, if a team is playing with
only 9 players, 2 players can still field outside the circle.
During Batting Powerplay Overs: Only three fielders allowed outside inner circle
regardless of the number of fielders inside the circle. For example, if a team is playing with
only 9 players, 3 players can still field outside the circle.
Non-Powerplay Overs: A maximum of 5 fielders are allowed outside the inner circle during
non-power play overs. This is regardless of the number of players fielding inside the circle.
For example, if a team is playing with only 9 players, 5 players can still be outside the inner
circle. This means that there will only be 2 players fielding inside the circle (excluding the
keeper and bowler).
Others: A maximum of 5 fielders are allowed on the leg side at any stage of the game
(excluding the bowler and keeper). Bowler guard – for example, right hand bowler bowling
around the wicket doesn’t count as a fielder.

Competition
Details

Regular T35 and T20 Grades:
1. 16 League Rounds for both T35 and T20, followed by finals. The finals structure depends on
the number of teams in the fixture — Quarter Finals (10 or more teams), Preliminary Semis
(8 or more teams), Semi Finals, and Grand Final.
2. Finals Format: Where possible, an IPL/BBL-style playoff system will be used. Under this
format, the top two teams on the ladder get two chances to reach the Grand Final, while
3rd and 4th place teams get one chance. Specifically — 1st vs 2nd (winner goes straight to
the Grand Final; loser gets another chance), and 3rd vs 4th (loser is eliminated). The two
losers/survivors then play a final qualifier, with the winner joining the top-two winner in the
Grand Final. This format may be adjusted based on the number of teams and available
dates.
3. All matches will be on Saturday afternoons, except for reserve days.
4. Reserve days only for Preliminary Semis, Semis and Finals
5. A player should have played minimum 6 league games to qualify for Preliminary Semis,
Semis and Finals
6. If a club has two or more teams participating in multiple grades, a player from the same
club can play in any team during the season but will only qualify for one grade where the
player has played most number of games in that grade. Same rule applies if a player has
played for two different clubs in the same grade.
Reduced T35 Fixtured Grades:
1. 10 League Rounds, followed by finals. The finals structure depends on the number of teams
in the fixture — Preliminary Semis (more than 6 teams), Semi Finals, and Grand Final.
2. Finals Format: Where possible, an IPL/BBL-style playoff system will be used. Under this
format, the top two teams on the ladder get two chances to reach the Grand Final, while
3rd and 4th place teams get one chance. This format may be adjusted based on the
number of teams and available dates.
3. 6 teams qualify for Preliminary Semis (only for some fixtures where the teams are more
than 6), if not 4 teams qualify for Semis.
4. All matches will be on Saturday afternoons, except for reserve days.
5. Reserve days only for Preliminary Semis, Semis and Finals
6. A player should have played minimum 4 league games to qualify for Preliminary Semis,
Semis and Finals
7. If a club has two or more teams participating in multiple grades, a player from the same
club can play in any team during the season but will only qualify for one grade where the
player has played most number of games in that grade. Same rule applies if a player has
played for two different clubs in the same grade.

Game Times

T35:
Toss: by 11:45 AM (if less than 6 players are available at toss time, opponent team will be
awarded the toss. If both teams have less than 6 players at toss time, the first team to have 6
players at toss time will be awarded the toss).
Fielding team: Minimum 6 players to start the game.
1st Innings:
Scheduled Start Time: 12 PM
Scheduled Finish Time: 2:15 PM
Innings Break: 15 mins
2nd Innings:
Scheduled Start Time: 2:30 PM
Scheduled Finish Time: 4:45 PM
Drinks break: 5 minutes drinks break at the end of 20th over.
T20:
Toss: by 7:45 AM (if less than 6 players are available at toss time, opponent team will be
awarded the toss. If both teams have less than 6 players at toss time, the first team to have 6
players at toss time will be awarded the toss).
Fielding team: Minimum 6 players to start the game.
1st Innings:
Scheduled Start Time: 8 AM
Scheduled Finish Time: 9:30 AM
Innings Break: 10 mins
2nd Innings:
Scheduled Start Time: 9:40 AM
Scheduled Finish Time: 11:10 AM
Drinks break: 5 minutes drinks break at the end of 10th over.

Umpires

1. One professional umpire will be present for all league rounds.
2. Two umpires will be provided for Pre-semis (if the fixture has one), Semi-Finals and Finals.
Teams have to pay for both the umpires.

Ground Setup

1. Home team (listed top on PlayHQ fixture) will have to setup stumps and cones for that
week. Home team has to also supply the scoreboard, spare used balls, white spray can,
first aid kit, measuring tape, ball counter, and the square leg umpire vest (any orange HiVis vest)
2. Home team to ensure the ground is left clean

Team Sheets

1. 12 players can play per side. Any 11 out of the 12 can bat. Any 12 out of the 12 can bowl.
Any 11 out of the 12 can field/wicket keep. All players should be added to the PlayHQ team
list before the game starts.
2. All games should be live scored using PlayHQ scoring website
(https://ca.score.playhq.com). No manual books are allowed unless there is an issue with
the PlayHQ scoring system.
3. All matches will be locked on the Wednesday the following week. Matches would be
unlocked if required by the association for valid reasons.

Delayed Starts

Weather/wet outfield: One over lost for every 4 mins of delayed start. Umpire will reduce
the overs equally between the teams.

Rain
Interruptions

60 minutes or more of rain interruption: If conditions are unsuitable to play again, game
should be called off and points are shared. Please note, it is up to the umpire’s discretion,
whether to continue the game or not if there is a slight drizzle. The umpire will also make the
decision on the ground and pitch conditions, whether it is suitable to play or not.
DLS (Duckworth Lewis) will come in play if the second innings is interrupted due to rain on
other weather conditions. PlayHQ scoring app has the DLS feature inbuilt and should be used
accordingly. If the app isn’t working, the ‘Revised Target’ rule will be followed. See ‘Revised
Target’ section below.

Bad Light

T35 only:
1. Only applicable for T35 at this stage due to ‘bad light after sunset’ concerns
2. Batsmen or bowling teams should not stop the game due bad light, until the official sunset
time for that day.
3. To check the official sunset time for the day, go to google.com on your mobile and search
with the word ‘sunset’. It will show the sunset time for the day in that local area.
4. No further ball should be bowled beyond the official sunset time. Result will be based on
DLS.
5. If the light conditions are gloomy (before the sunset time), the officiating umpire will assess
the light conditions and make a final call if the spinners are to be bowled until the light
conditions improved or until the closure of play if the conditions are not improving.
6. Batting powerplay can still be taken during this time. Bowling team shouldn’t object for
bowling spinners or for the batting powerplay if umpire has made the final call.

Reduced overs
for delayed
starts and
finishes

T35 only:
1. Only applicable for T35 at this stage due to ‘bad light after sunset’ concerns
2. When teams turn up late, an over will be reduced for every 4 mins of delay past the 5
minutes of scheduled start time (that is 12:00 PM for T35).
3. First innings should be completed by 2:15 PM. If the team bowling first had a delayed finish
to their innings, when they come on to bat, they will have reduced overs. An over will be
reduced for every 4 mins of delayed finish past 2:15 PM. On such instances, the target to
chase remains the same. If the team fielding second had a delayed finish (that is, unable to
complete the bowling innings by the ‘Scheduled Finish Time’ or official sunset time
(whichever is applicable), then DLS comes into play. See ‘Rain Interruptions’ section
above for DLS rules.
4. Umpires will be warning the teams throughout the course of the game if teams are behind
their over rate. Generally speaking, 15 overs per hour if you have mix of pace bowlers and
spin bowlers in that hour.
5. Penalties may apply if a team turn up late on multiple occasions during the season.
6. A team must start the game as soon as there are 6 players in the ground.
7. If a team doesn’t have 6 players by 12:30 PM, that team is considered a forfeit.
DLS Notes:
8. Umpires will apply DLS if the second innings could not be finished by the fielding team
within the scheduled closing time, or as agreed during the course of the game with
captains.
9. The DLS rule is at the full discretion of the umpires considering all the circumstances of the
game. If the umpire allowed a bit of levy for the first fielding team that finished late during
the first innings, the umpire will also allow similar levy during the second innings for the
team fielding second.
10. Rules like these are a joint effort between the captains and the umpire. Any DLS
discussions should happen during the game. Decisions won’t be overturned by the
association after the game.

Revised Target

1. For rain interrupted games, if PlayHQ is not working, the revised target is determined by
the run rate of the first innings score.
a. Example: If Team A scores 175 in 35 overs (at a run rate of 5 runs per over), and if there
is a rain interruption for Team B during their batting innings, and the 2nd innings has
been revised to 15 overs. The revised target is 75 runs (15 overs x 5 run rate = 75 runs).
2. Minimum 5 overs to be played in either first or second innings for a result. Otherwise, the
game is considered a draw.
3. If complete game was washed out, the game is considered abandoned.
4. For a draw or abandoned game, the match points will be shared between both teams.
5. A win gets 6 points. A draw gets 3 points each.

Free hit

1. Free hit applies for every no-ball such as waist height, over-stepping, ball landing outside
the mat, above shoulder/head short balls, etc.
2. Second short ball above the shoulder in the same over is referred to as a no-ball
3. Bowler disturbing the stumps at the non-striker end while bowling will be considered a noball
4. All no-ball calls including waist high no-balls will be called by the official/main umpire.
Official/main umpire may consult the square leg umpire if in doubt. The final call will be
made by the official/main umpire.
5. Any ball bowled down leg side on a free hit delivery ball to be called a wide

Square Leg
Umpires
(Players)

1. All teams to provide an Orange Hi-Vis Vest and Ball Counter for Square Leg Umpires.
2. Square Leg is required to reset the stumps when broken on the keeper end.
3. Square Leg Umpires are not to interact or speak with batters during overs, in between
overs or at the fall of a wicket. If they are observed doing so a 5-run penalty will be
awarded against the batting team and they are to be rotated off from square leg duties.
4. Square leg umpires are not to carry mobile phones or drink bottles. If they are observed
doing so a 5-run penalty will be awarded against the batting team and they will be rotated
off from square leg duties.
5. A quick drink may be allowed during the change of ends or when a wicket was fallen.

Leg Side Wides

T35:
1. ‘One’ warning per over down the leg (unless it’s too far - which is going to be a wide
without a warning). Anything after that will be a wide. If the first one down the leg was
given a wide (because it is too far), the next one down the leg will be considered a warning
(if it is not too far).
2. The last ball of any over bowled down leg side to be called a wide
3. Any ball bowled down leg side on a free hit delivery ball to be called a wide, and the free
hit will be moved to the next delivery.
T20:
1. Any ball down the leg is considered a wide.
2. Any ball bowled down leg side on a free hit delivery ball to be called a wide, and the free
hit will be moved to the next delivery.

Yellow/Red Card
Offence

1. If a player is issued a yellow card the umpire is to report the player and details of incident
to the board via email.
2. If a player receives two yellow cards in the same game he will be disqualified from playing
for the rest of the game and he cannot be replaced for the remainder of the game.
3. The umpire to report all incidences to the board by email by the following Sunday evening
at the latest.
4. The board to investigate two yellow or red card reports and proceed with disciplinary
action.
5. Any player receiving 3 yellow cards during the season will receive an automatic suspension
of one game. Any further yellow cards thereafter during the season will automatically incur
a further one match suspension penalty.
6. One card to be deducted from the number of cards issued for the following season,
example if a player receives 2 yellow cards during the season 1 will be deducted leaving 1
remaining current for the following season.

Team Attire

1. All teams to have uniforms, including the same hoodie/jumper/jacket.
2. Teams that do not have coloured uniforms have to be dressed in whites only.
3. Any coloured or white uniforms are permitted as long as all the team members are wearing
the same uniform.
4. Full team must wear the same uniform, that is full whites or full club coloured uniform. No
mix matching. Teams must carry spares for last minute fill-ins who may have whites or club
coloured uniform.
5. No mixed uniforms from different clubs.
6. 5-runs will be deducted from the team’s score for each player that doesn’t have proper
uniforms.

Bowler Clothing

1. If the fielding team is wearing white clothing, and if the batsmen on strike has sighting
concerns, the batsmen can request the umpire for the bowler of that particular over to
wear a black top (t-shirt/jumper/hoody) for the duration of that over.
2. Only black coloured top, no other colours.
3. Teams are to always carry couple of spare black tops.
4. The bowler can continue to wear whites while bowling, if the batsman on strike doesn’t
have any sighting concerns.

Umpire/Captains
Reports

1. Umpires to provide match report by the Sunday evening at the latest. This provides
ongoing feedback to committee.
2. Captains can provide match day report by the Sunday evening at the latest. This is
optional.
3. Captains can also email the association directly for any match day matters.

Match Result

Home team to enter match results manually by 10 PM the following day if PlayHQ Live
Scoring wasn’t working during the match time.

Umpires Decision

Umpires’ decision is the final decision throughout the course of the match. Email the
committee for any disputes or complaints after the game (within 48 hours of completion) - m
elbournecricketassociation@gmail.com

Fees

Fees are as advised in the competition flyers.
Bank Details,
Name: MCA
BSB: 063106
Account number: 10904465
Reference: Please use your team’s name as per the PlayHQ fixture

Umpire Fee

T35:
$85 per team to be paid by each team in full if the game starts. If the game gets called off
before the ball is bowled, half payment to be made to the umpire. If the association calls off
the game (before 11 AM on the game day), then no umpire fee to be paid by the teams.
T20:
$65 per team to be paid by each team in full if the game starts. If the game gets called off
before the ball is bowled, half payment to be made to the umpire. If the association calls off
the game (previous night of the game), then no umpire fee to be paid by the teams.
Umpire payments should be paid before the toss. Can be an online payment (PayID or bank
transfer).

Balls

Balls ($30 a ball) to be purchased by the teams directly from Hoppers Crossing Cricket
Store - (03) 9369 5410 or any other sports shop nearby.
Ask for MCA Kookaburra Crown 2-piece white ball. There is an association specific ball with a
logo on it.

Other Rules
Powerplay for
games with
reduced overs

International cricket rules apply in general where not exclusively specified in this rule book.
Total overs in the innings

Total Powerplay Overs

5-6

1

7-9

2

10-13

3

14-16

4

17-19

5

20-22

6

23-25

7

26-28

8

29-31

9

32-35

10

Reduced powerplay overs will be shared half each between mandatory and batting
powerplays. If the reduced powerplay overs are in odd number, it will be divided by 2 and the
higher number will be for the mandatory powerplay. For example, if reduced powerplay is 7
overs in total, first 4 overs of the innings will be mandatory powerplay overs and 3 will be
batting powerplay overs chosen anytime during the innings by the batting team.

Player
Registration and
Fill-ins

1. All players should be registered on PlayHQ
2. A registered player cannot play for two teams in the same tournament on the same day.
3. A player wishing to play for another team in the same fixture will need a Transfer, not a
Permit. If two teams are from the same club, then the player Transfer/Permit is not
required.
4. Its captain’s responsibility to check whether a player has played for another team in the
same fixture.
5. If a player gets reported noncompliance of the above rules, the association committee
would be awarding points to the loosing team or taking off points from the ladder.
6. A team can have as many fill ins as needed, as long as the fill in rules are followed.
7. Fills ins are permitted but they have to be either registered or be added using the ‘game
permit’ option (refer to ‘PlayHQ Game Permit’ link at the end of the rule book) if it’s only
once off or while waiting for the permit/transfer approvals to come through.
8. If the player never played cricket using their PlayHQ ID, they can be used as a ‘Fill In’ in
PlayHQ (also known as PlayHQ Fill In). A PlayHQ fill in is only for the first game. Second
game onwards (if at all), they must be fully registered.

Reserve Days

1. If a league game is washed out by rain, there are no reserve days and points will be
shared.
2. Only Pre-semis, Semi Finals and Grand Finals will have reserve days.
3. If a Pre-semis or Semi Final is washed out on a reserve day (game has not started or was
not completed) the team that finished on top of the ladder goes through to the next stage.
4. If a Grand Final is washed out on a reserve day (game has not started or was not
completed) the team that finished on top of the ladder will be awarded the championship.

No-balls

Any ball above the batmen’s waist (without pitching the ball) will be called a no-ball
regardless of the bowler type (i.e., spin or medium or pace).
A ball above the shoulder (without pitching the ball) is considered a beamer. Two such
beamers by a bowler during the course of the game will not be continued to bowl for the rest
of the game.

Slow over rate

While there is no blanket rule covering slow over rates, the general conscious is that the
umpire would keep an eye on the over rate and keep reminding the fielding team if they are
running behind.

Players arriving
late

No restrictions on players arriving late. They can bowl or bat anytime. This will go hand in
hand with the other rule that is ‘a player should not be playing two games at the same time
slot’ within the same club or another grade/comp. So, if a player turned up late, that could be
because of a ‘running late’ scenario, or coming from work scenario, or due to other family
commitments, etc., but not coming from another game.

Balls

1. MCA Kookaburra Crown 2-piece white ball to start with.
2. Will assess the ball colour and durability as we go through the season and change if it is
required.
3. We may try out other branded balls if needed for a few rounds.

Abuse

1. No personal or racist comments will be tolerated. No abuse will be tolerated.
2. If any team gets involved in any physical abuse or fight, there will be strict actions.

Fielder’s call

Fielder’s call is to be accepted for the boundaries, unless the umpire can clearly see the
fielder going over a cone or the fielder touching the cone. Where there is no cone in the area
fielded, fielder’s call stays.

Bowling action
objections

1. A batsman or a team shouldn’t stop a bowler for suspected bowling action. The objecting
team's square leg umpire may record a clipping or multiple clippings to cover the entire
over and send it to the association for review.
2. The square leg umpire should notify the main umpire that he is going to record the bowler
action. Main umpire should then notify the bowler.
3. Videos should not be recorded without notifying the umpire.
4. If the bowler is identified to be chucking the ball or needs correction, the association may
advise the player to take a training session at Cricket Victoria to rectify the bowling action.

Awards

Awards for the One Day competition,
1. Best bowler of the tournament
2. Best batsman of the tournament
3. Best fielder of the tournament
4. Best keeper of the tournament
5. Most 6s award for T20
6. Man of the match for every game including Pre-Semis, Semi Finals and Grand Finals
7. Medals and trophies for all the players in the winning team
8. Medals for all the players in the runner up team
9. Championship trophy for the winning team
10. Runner up trophy for the runner up team
11. ‘Finals Umpire’ Trophy for the umpires in Grand Finals
12. Any other recognition awards

FrogBox/YouTube
Live Streaming

1. Some games will be live streamed through FrogBox on PlayHQ app and YouTube channels.
2. Umpires will also allow extra time to fix any Live Streaming issues.
3. All participating clubs/teams are assumed to be in acceptance of the privacy laws around
this.

Online Scoring

1. All games should be scored online through the PlayHQ website on a phone or a tablet. No
exceptions to this.
2. Umpires will allow extra time to fix any technology issues.

Lost ball

1. In case a ball is lost during play, please replace them with an old used ball from a previous
game.
2. Umpire will agree on the ball’s condition.

Game forfeits

If you do not have enough players and cannot play that week’s game, please notify the
opponent team and the association by Thursday before 8 pm.

COVID Rules

1. No Kit or food sharing.
2. All the waste should go into the bins.
3. No saliva on the ball.

PlayHQ Links

Creating a Team: https://support.playhq.com/hc/en-au/articles/900003189363-Managing-te
ams
Selecting Team: https://support.playhq.com/hc/en-au/articles/4407752360601-My-Teams-Se
lect-Line-Ups-and-Player-Positions
Adding / replacing a Fill-in Player: https://support.playhq.com/hc/en-au/articles/52802581
02937-Managing-Fill-in-Players-via-Admin-Portal
How to Live Score: https://support.playhq.com/hc/en-au/articles/5132680466969-How-To-EScore-Cricket
Other Live Scoring Guides: https://support.playhq.com/hc/en-au/sections/5460166848025Electronic-Scoring-for-Cricket
PlayHQ Game Permit: https://support.playhq.com/hc/en-au/articles/4405246316697-Creati
ng-a-Game-Permit-Request
PlayHQ Support Request: https://mycricketsupport.cricket.com.au/hc/en-us/requests/new?t
icket_form_id=46984
Other Admin Guides: https://support.playhq.com/hc/en-au/categories/900000236046-Admi
ns-for-Competitions`;

const RULE_BOOK_JUNIORS = `Melbourne Cricket Association (MCA)
Juniors Competition Rules – Winter 2026

| Applies to | Rule |
| --- | --- |
| Association Committee | President: Gopi Kakivai – 0430 667 896 · Secretary: Mahendra Annem – 0433 960 586 · Treasurer: Sandeep Shamala – 0433 249 914Umpires Coordinator: Srikanth Dendi – 0430 408 093 · Juniors Coordinator: · Deepak Kulkarni · 0404 073 222 · deepak7kulkarni@gmail.com |
| Disputes and Complaints (within 48 hours of game completion) | melbournecricketassociation@gmail.com |
| Dispensation Requests (by 5 PM Thursday before the game) | melbournecricketassociation@gmail.com. Include player name, DOB, and grade requested. |
| Rules Version | v0.4 (10/05/2026) |

Rules at a Glance

| Rule | U11 | U13 | U15 |
| --- | --- | --- | --- |
| Format | 25 overs per side | 25 overs per side | 30 overs per side |
| Match Days | Alternate Sundays | Alternate Sundays | Alternate Sundays |
| Season Start | 26 April 2026 | 26 April 2026 | 26 April 2026 |
| Start Time | 12:30 PM | 12:30 PM | 12:30 PM |
| Age Range (on 26 Apr 2026) | 8 to 11 years | 9 to 13 years | 12 to 15 years |
| DOB Window | 27 Apr 2014 – 26 Apr 2018 | 27 Apr 2012 – 26 Apr 2017 | 27 Apr 2010 – 26 Apr 2014 |
| Dispensations | Email MCA | Email MCA | Email MCA |
| Match Ball | Kooka Soft Pink – 130g | MCA Stamped Kooka Crown White 2 Piece – 142g | MCA Stamped Kooka Crown White 2 Piece – 156g |
| Umpire Fee (per team) | $65 | $65 | $70 |
| Pitch Length | 16 m | 18 m | 20 m (full size) |
| Players per Team (Ideal) | 7 | 9 | 11 |
| Players per Team (Min / Max) | 5 – 11 | 7 – 11 | 7 – 13 |
| Max Players on Field | 7 | 9 | 11 |
| Boundary | 40 m from centre of pitch | 45 m from centre of pitch | 55 m from centre of pitch |
| Inner Circle | N/A | 20 m | 25 m |
| Batter Retirement | See detail below | See detail below | After 50 runs |
| Wickets to End Innings | Unlimited dismissals | Innings ends at wicket cap by team size: 7 players → 6 wkts; 8 → 7; 9 → 8; 10 → 8; 11 → 9 | 10 wickets |
| Dismissal Penalty | 4 runs to fielding team per dismissal | N/A | N/A |
| LBW | No | No | Yes |
| Ball Delivery Rule | 3 or more bounces before batter's crease = no-ball | N/A | N/A |
| Max Balls per Over | 6 (all deliveries count, incl. wides/no-balls) | 6 (all deliveries count, incl. wides/no-balls) | 8 (6 legal deliveries required) |
| Consecutive Overs per End | 5 overs per end | 5 overs per end | 5 overs per end |
| Max Overs per Bowler | 5 | 5 | 6 |
| Min Bowlers Used | All must bowl | All must bowl | Min 6 |
| Bowling Order Rule | All (incl. keeper) bowl 2 before 3rd; all (incl. keeper) bowl 3 before 4th | All (incl. keeper) bowl 2 before 3rd; all (incl. keeper) bowl 3 before 4th | No restriction beyond max 6 |
| Bowling Powerplay | None | First 4 overs – max 2 outside circle | First 5 overs – max 2 outside circle |
| Batting Powerplay | None | 4 overs (batting choice) – max 3 outside circle | 5 overs (batting choice) – max 3 outside circle |
| Total Powerplay Overs | None | 8 overs per innings | 10 overs per innings |
| Non-Powerplay Fielding | N/A | Max 4 outside inner circle | Max 5 outside inner circle |
| Max Fielders on Leg Side | N/A | N/A | 5 (excl. bowler & keeper) |
| Fielding Safety Zone | 15 m from batter (keeper excepted) | 10 m from batter (keeper & slips excepted) | 10 m from batter (keeper & slips excepted) |
| Free Hit | No | No | Yes – every no-ball |
| Leg-Side Wides | Standard | Standard | 1 warning per over (unless too far – immediate wide). · After warning: any leg-side = wide. · Last ball of over: immediate wide. · Down leg on free hit = wide + free hit carries. |
| Helmets | Mandatory – batters & keepers | Mandatory – batters & keepers | Mandatory – batters & keepers |
| Points System | As per PlayHQ | As per PlayHQ | As per PlayHQ |
| Finals Qualification | Top 4 teams | Top 4 teams | Top 4 teams |
| Min Games for Finals | 3 league games | 3 league games | 3 league games |
| Finals Format | PlayHQ Standard (double chance for 1st & 2nd) | PlayHQ Standard (double chance for 1st & 2nd) | PlayHQ Standard (double chance for 1st & 2nd) |
| Forfeit Notice | Saturday 6:00 PM (day before) | Saturday 6:00 PM (day before) | Saturday 6:00 PM (day before) |
| Live Scoring | PlayHQ Live Scoring only | PlayHQ Live Scoring only | PlayHQ Live Scoring only |
| Live Streaming | Optional – Frogbox (see guidelines) | Optional – Frogbox (see guidelines) | Optional – Frogbox (see guidelines) |

Detailed Rules

### Batter Retirement

| Applies to | Rule |
| --- | --- |
| U11 & U13 | Formula: Total balls in innings ÷ number of players in the team (round down). · Balls per batter by team size: · 5 players: 30 balls   /   6 players: 25 balls   /   7 players: 21 balls   /   8 players: 18 balls   /   9 players: 16 balls   /   10 players: 15 balls   /   11 players: 13 balls · All deliveries (including wides and no-balls) count toward a batter's ball count. A batter must retire immediately upon reaching their allocation – not at the end of the over. · Where the per-batter allocation does not divide evenly into the total balls in the innings (e.g. a 7-player team has 21 balls per batter × 7 = 147 of 150 balls; 3 balls are unallocated): · U11: the last batsman faces the remaining balls. The team manager/coach nominates which player bats last. · U13: there is no nominated last batsman. The innings runs to its allocated overs unless the wicket cap is reached first (see Wickets & Dismissals below); a dismissed batter does not return, so any unused per-batter allocation lapses with that batter. |
| U15 | Batters retire after scoring 50 runs. · Retired batters may return at the fall of the last available wicket and continue until dismissed or the innings is completed. |

### Wickets & Dismissals

| Applies to | Rule |
| --- | --- |
| U11 & U13 | U11: Unlimited dismissals. All batters face their full ball allocation, and the innings concludes when all allocated overs are bowled; retired and dismissed batters do not return. · U13: The innings ends when the wicket cap for the team's size is reached, or when all allocated overs are bowled, whichever comes first. Wicket cap by team size: 7 players – 6 wickets; 8 players – 7 wickets; 9 players – 8 wickets; 10 players – 8 wickets; 11 players – 9 wickets. A dismissed batter does not return. A batter who retires not out returns to bat at the fall of the last available wicket (i.e. once the wicket cap less one has been reached) and continues until dismissed or the innings ends. Where more than one batter has retired not out, they return in order of retirement. The chasing team, if the wicket cap has not been reached, may bat its full allocation of overs. Where the wicket cap is reached, the innings ends immediately even if remaining batters have not used their full ball allocation. · Dismissal Penalty (U11 only): 4 runs are added to the fielding team's total for every dismissal. · Dismissal Penalty (U13): None. A dismissed batter is out and does not return; no runs are added to the fielding team's total. · LBW: Not applicable in U11 or U13. · Ball Delivery Rule (U11 only): A delivery that bounces three or more times before reaching the batter's crease is called a no-ball. |
| U15 | 10 wickets end the innings. · LBW: Applies in U15. |

### Bowling

| Applies to | Rule |
| --- | --- |
| U11 & U13 | Max 5 overs per bowler. Max 6 balls per over. All players must bowl. · Bowling Order Rule: All players, including the wicketkeeper, must complete 2 overs before any bowler bowls a 3rd over. All players, including the wicketkeeper, must complete 3 overs before any bowler bowls a 4th over. |
| U15 | Max 6 overs per bowler. Max 8 balls per over (6 legal deliveries required). Minimum 6 bowlers must be used. Wicketkeepers are not mandated. |

### Powerplay & Fielding Restrictions

| Applies to | Rule |
| --- | --- |
| U11 | No powerplay. No inner circle. · No fielder may stand closer than 15 m to the batter (wicketkeeper excepted). |
| U13 | Bowling Powerplay: First 4 overs – maximum 2 fielders outside the 20 m inner circle. · Batting Powerplay: 4 overs of the batting team's choice – maximum 3 fielders outside the inner circle. · Total Powerplay: 8 overs per innings. · Non-Powerplay: Maximum 4 fielders outside the inner circle. · No fielder may stand closer than 10 m to the batter (wicketkeeper and slips excepted). |
| U15 | Bowling Powerplay: First 5 overs – maximum 2 fielders outside the 25 m inner circle. · Batting Powerplay: 5 overs of the batting team's choice – maximum 3 fielders outside the inner circle. · Total Powerplay: 10 overs per innings. · Non-Powerplay: Maximum 5 fielders outside the inner circle. · Maximum 5 fielders on the leg side at any stage (excluding bowler and keeper). · No fielder may stand closer than 10 m to the batter (wicketkeeper and slips excepted). · End changes occur every 5 overs throughout the innings. |

### No-Balls, Free Hit & Leg-Side Wides

| Applies to | Rule |
| --- | --- |
| U11 & U13 | No free hit. Standard wide rules apply (any ball deemed too wide for the batter to play a normal cricket shot is called wide). The U15 leg-side warn-then-wide regime does not apply in U11 or U13. |
| U15 | Free Hit: A free hit is awarded for every no-ball (overstepping, waist height, above shoulder/head, ball outside mat, etc.). On a free hit, the batter can only be dismissed by run-out, hit ball twice, or obstructing the field. · Any ball bowled down the leg side on a free hit delivery is called a wide – the free hit carries to the next delivery. · Second short ball above the shoulder in the same over = no-ball. · Bowler disturbing the stumps at the non-striker end while bowling = no-ball. · All no-ball calls are made by the official (main) umpire. The main umpire may consult the square-leg umpire. · Leg-Side Wides: One warning per over for a ball going down the leg side (unless clearly too far – immediate wide). After a warning, any subsequent leg-side delivery in that over = wide. The last ball of any over bowled down the leg side = immediate wide (no warning given). |

### Hours of Play, Delayed Starts, Rain Interruptions & DLS (all grades)

| Applies to | Rule |
| --- | --- |
| Hours of Play | Scheduled start: 12:30 PM (all grades). · First innings cut-off: 2:10 PM (U11 & U13) or 2:30 PM (U15) – the over in progress at the cut-off is completed. · Innings break: 10 minutes. · Scheduled finish (second innings cut-off): 4:20 PM (U11 & U13) or 5:00 PM (U15). · Overs caps remain 25 (U11/U13) and 30 (U15). |
| Delayed Starts | One over is deducted from each innings for every 4 minutes of delayed start past 12:30 PM. Overs are reduced equally across both innings by the umpire. · A team must start as soon as the grade minimum is present (U11: 5; U13: 7; U15: 7). If a team does not have the grade minimum by 1:00 PM, that team forfeits. |
| Rain Interruptions | A cumulative rain interruption of 60 minutes or more – if conditions are unsuitable to resume, the game is called off and points are shared. · For shorter interruptions, the umpire determines whether to resume. Slight drizzle is at the umpire's discretion. |
| DLS | DLS applies when the second innings is interrupted by rain or weather. Use the DLS feature in the PlayHQ scoring app. · Revised Target (if PlayHQ unavailable): Revised target = Revised overs × First innings run rate. Example: Team A scores 100 in 25 overs (run rate 4.0). Second innings revised to 15 overs. Revised target = 15 × 4.0 = 60 runs. |
| Minimum Overs | 5 overs must be completed by each team for a result to stand. If not achieved, the game is a draw and points are shared equally. · Drawn / Abandoned: Points shared equally. Full washout with no play: match abandoned, points shared. |
| Bad Light (U15 only) | Play continues until the official sunset time (search "sunset" on Google for local time). No ball to be bowled after sunset. · If light is poor before sunset, the umpire may direct that only spinners are bowled. The batting team may still take their batting powerplay. The bowling team may not object once the umpire has directed. · Results in games shortened due to bad light are determined by DLS. |
| Over Rate | Teams are expected to maintain approximately 15 overs per hour. Umpires will warn teams falling behind. Persistent delays may result in penalties at the association's discretion. |
| Square-Leg Umpire | The square-leg umpire is provided by the batting team for each innings. |

### Live Scoring & Live Streaming

| Applies to | Rule |
| --- | --- |
| Live Scoring | PlayHQ Live Scoring is mandatory for all matches. No manual scorebooks. The scorer is nominated by the batting team for that innings (any nominated person — player, parent, official — may score). |
| Live Streaming | Optional. Clubs choosing to stream must comply with all requirements below. · Consent for Under-18 Participants: Clubs must confirm consent in FrogBox Go for any under-18 participants within 72 hours of the scheduled match start time. · Access to Streams: · Junior streams are accessible via an unlisted YouTube link shared by the hosting club. Once under-18 consent is confirmed, live streams and match highlights will also appear in the Play Cricket app. · Access via the Play Cricket app is restricted to consented under-18 participants and protects players' privacy. · Resources: · See the Video Streaming requirements and Email Template on the Play Cricket Support website. · Clubs are encouraged to communicate with parents as early as possible before the season begins. · Complaints & Content Removal: · Email melbournecricketassociation@gmail.com. · Any footage subject to a valid complaint will be removed promptly from all online platforms. · All videographers or video editors must hold a current Working with Children Check and must agree in writing that footage will only be used for purposes approved by the club and the association. |

### Match-Day Operations

| Applies to | Rule |
| --- | --- |
| The Toss | The toss is to be conducted at least 15 minutes before the scheduled start of play, provided both teams have the minimum number of players present. If a team does not have the minimum number of players 15 minutes before start time, that team forfeits the toss. |
| Forfeits | A team unable to field at least the minimum number of players within 30 minutes of the scheduled start time forfeits the match.Consequences:•  The team giving the forfeit receives no points; the receiving team is awarded a maximum‑points result.•  The forfeiting team is liable for the full umpire fees for both sides.•  Late notice (after Saturday 6:00 PM) or no-show forfeits incur a fine in addition to umpire fees.•  Any team forfeiting three matches in a season will be deemed to have withdrawn from the competition. |
| Substitute / Loan Players | Loan players (when one team is short and the opposition has surplus):•  Strongly encouraged in the spirit of the game.•  May bat, bowl and field.•  Their batting and bowling figures count for the team they are loaned to for that match.Substitute fielders (covering illness or injury during the match):•  May field only — they may not bat, bowl, or wicketkeep.•  Maximum two sub fielders on the field at any time.•  Must be flagged to the opposition coach and umpire before taking the field, and must be PlayHQ-registered. |
| Home Team Responsibilities | By the scheduled start time, the home club must ensure:•  Crease lines clearly marked.•  Boundary markers in place per the age-group dimensions.•  Inner-circle markers placed (U13/U15).•  Stumps and bails set up.•  Scorers' table and chairs available.•  Clubrooms and toilet access available where possible.•  Ground mowed and pitch in playable condition.•  Sprinklers programmed off the night before.Both teams must leave the pitch and ground in good order at the end of the match. |
| Fill Ins | Where a player's transfer or permit has not yet completed, the player may take the field as a Fill In for that match. The Fill In must be entered in PlayHQ using the player's exact registered name. Once the transfer or permit is finalised (typically by the Thursday following the match), the Fill In entry must be replaced with the player's actual PlayHQ profile. See PlayHQ Links at the end of this document for Fill Ins and Replacement of Fill Ins. |
| Springback Stumps (U11 & U13) | Springback stumps are mandatory for U11 and U13 matches. Where springback stumps are used, the stumps are deemed broken if the ball strikes the stumps (other than the metal base), even if the bails do not dislodge. |
| Ball Replacement | If during play the ball is lost, cannot be recovered, or in the umpire's opinion has become unfit for play, the umpire shall replace it with a ball of comparable wear. The umpire shall inform both batters and the fielding captain at the time of replacement. |
| Coach on Field | In all age groups, a coach or assistant coach is permitted to assist the team captain with field placements during play, provided this does not delay the game and is not used to coach the batter or to distract opponents. |
| Pitch Surface | All MCA matches are played on synthetic pitches. MCA does not play on turf wickets. |
| Finals Eligibility | To qualify for finals in a particular team, a player must:•  Have played a minimum of 3 home-and-away matches for that team during the season; and•  Have played more games for that team than for any other team in the same age group across the season.“Active participation” means having batted, bowled, or fielded in the match.The MCA Committee may grant exceptions in extenuating circumstances (e.g. multiple washouts, extreme heat) on written application from the club at least 48 hours before the match. |

### Child Safety & Compliance

| Applies to | Rule |
| --- | --- |
| Policy Adoption | MCA endorses and adopts Cricket Australia's Policy for Safeguarding Children and Young People, Cricket Australia's ‘Looking After Our Kids’ Code of Behaviour, Cricket Victoria's Member Protection Policy, and Cricket Victoria's Reporting and Complaints Policy. All clubs, coaches, players, parents and officials are bound by these policies and by the MCA Code of Behaviour set out in this document. |
| Child Safety Officer & Complaints Manager | Deepak Kulkarni · 0404 073 222 · deepak7kulkarni@gmail.com |
| Working with Children Check (WWC) | All coaches, assistant coaches, team managers, regular training staff, scorers who interact with players, and any videographers or video editors must hold a current Working with Children Check. Clubs must keep a copy on file and make the record available to MCA on request. |
| First Aid | Every team must carry a First Aid kit in its gear bag at all matches.Minimum contents:•  Bandages, cotton wool, gauze.•  Adhesive plaster, Band-Aids, wound closures.•  Scissors, tweezers.•  Antiseptic.•  Disposable gloves, disposable plastic bags.•  Ice pack.Failure to provide a First Aid kit on request may result in a fine. |
| Sun Safety | Clubs are to follow the SunSmart policy.• Wide-brimmed hats are to be available as an option (in addition to caps).• Three-quarter or long-sleeved shirts are preferred.• Each team shall have a 5-litre drinks container at every match. |
| Helmets | An approved helmet with visor/grille is mandatory for all batters and wicketkeepers in every age group at all times while batting or wicketkeeping. If a wicketkeeper is not wearing a helmet, the umpire shall stop play until the keeper complies. |
| Insurance & Registration | All players must be registered on PlayHQ — PlayHQ registration is the players' insurance vehicle. Each club is responsible for its own public liability insurance covering the club and its activities. |
| Proof of Age | All new players must provide a copy of their birth certificate (or other suitable proof of age) to the club at registration. Clubs must keep a copy on file and produce it on request. |

### Code of Behaviour & Disputes

| Applies to | Rule | Rule |
| --- | --- | --- |
| Spirit of Cricket | All matches are to be played in the Spirit of Cricket. Players, coaches, parents and spectators must respect umpires, opponents, and each other. Sledging, send-offs, dissent, abuse of officials, and any conduct contrary to the Cricket Victoria Member Protection Policy are reportable. |  |
| Alcohol | Consumption of alcohol is forbidden in or in visible proximity to a junior match, before, during, or immediately after the game. |  |
| Reporting | Breaches of the Code of Behaviour, the Laws of Cricket, or these rules may be reported by any umpire, club official, or affected party to melbournecricketassociation@gmail.com within 48 hours of game completion. The notification must include match details, the people involved, and the nature of the alleged breach. |  |
| Dispute Resolution | The MCA Committee will review the report, may seek further evidence from any party, and will issue a written decision within 7 days of receiving the report. The Committee may reprimand, fine, suspend, or impose any other penalty it considers appropriate to the nature of the breach. Decisions of the MCA Committee are final. |  |
| Suspect Bowling Action | MCA is a juniors-only competition. No umpire shall call a no-ball for a suspect action on the field.If an umpire or batting-side coach has concerns about a bowler's action:•  Raise the concern quietly with the offending bowler's coach after the match.•  Report it to the Juniors Coordinator.•  The Coordinator will contact the player's club to enquire what corrective action is being taken.The player shall not be ostracised or publicly called out. Repeated concerns may result in the player being prevented from bowling until their club provides evidence the action has been corrected. |  |
| PlayHQ Links | Creating a Team | https://support.playhq.com/hc/en-us/articles/23976947679132-Managing-teams |
| Selecting Team | https://support.playhq.com/hc/en-us/articles/23974184481436-My-Teams-Select-Line-Ups-and-Player-Positions |  |
| Adding / replacing a Fill-in Player | https://support.playhq.com/hc/en-au/articles/5280258102937-Managing-Fill-in-Players-via-Admin-Portal |  |
| How to Live Score | https://support.playhq.com/hc/en-au/articles/5132680466969-How-To-EScore-Cricket |  |
| Other Live Scoring Guides | https://support.playhq.com/hc/en-au/sections/5460166848025-Electronic-Scoring-for-Cricket |  |
| PlayHQ Game Permit | https://support.playhq.com/hc/en-us/articles/23977397579420-Creating-a-Game-Permit-Request |  |
| How to Raise a PlayHQ Support Request | https://mycricketsupport.cricket.com.au/hc/en-us/requests/new?ticket_form_id=46984 |  |
| Other Admin Guides | https://support.playhq.com/hc/en-au/categories/900000236046-Admins-for-Competitions |  |
`;

const SYSTEM_PROMPT = `You are MCA Assistant, the chat helper on the Melbourne Cricket Association (MCA) website — a community cricket association in Melbourne, Australia running Saturday senior competitions and Sunday junior competitions.

SCOPE
Only answer questions about MCA: competitions and formats, playing rules, fees and payments, registration, grounds, umpiring, juniors, finals, awards, live scoring and streaming, and how to reach the committee. You may also answer general cricket-rule questions where they help a player, captain or umpire understand MCA play. For anything unrelated — other sports, general news, chit-chat, personal advice — politely say it is outside what you cover and steer back to MCA topics. Do NOT web search for out-of-scope questions.

ANSWER THE QUESTION
Answer it directly. Do not deflect to "contact the committee" when you already know the fact. Use web search whenever a current or specific detail would genuinely help — live fixtures, ladder positions, PlayHQ pages, weather affecting play, Cricket Australia or Cricket Victoria policy — and then give the actual numbers with markdown links to the official source.

ANSWER IN DETAIL
Players, captains and umpires use your answers to settle real on-field questions, so be thorough rather than brief:
- Give the full rule, not just the headline number.
- Include the exceptions, edge cases and thresholds that actually come up — what happens with reduced overs, with fewer than 11 players, on a free hit, after a warning, when the game starts late.
- Where T20 and T35 differ, or where U11/U13/U15 differ, spell out each one rather than generalising.
- Grades do not share rules. If the question names a grade (U11, U13, U15, T20 or T35), answer only from that grade's rules — never fill a junior answer from the senior rule book or the reverse. If the grade is not stated and the answer differs by grade, give each grade rather than picking one.
- Where the rule book gives a reason or a worked example, include it.
- Say who makes the call (main umpire, square-leg umpire, captain, committee) when a rule depends on a decision.
A typical answer runs several sentences or a short table plus a few bullets. Only be brief when the question is genuinely a one-liner, such as a phone number.

FORMATTING — answers must be scannable, never a wall of text
- Lead with a one-sentence direct answer, then expand.
- TABLES: use one whenever you list 3 or more items that each carry a value, cost, date or grade — competitions, fee breakdowns, age groups, umpire fees, key dates. A table is almost always clearer than prose for these.
- Every table MUST have a separator row of dashes directly under the header row, or it will not render. Always write tables in exactly this shape:
| Grade | Ages | DOB window |
| --- | --- | --- |
| U11 | 8–11 | 27 Apr 2014 – 26 Apr 2018 |
| U13 | 9–13 | 27 Apr 2012 – 26 Apr 2017 |
  Put every row on its own line. Never run rows together on one line.
- OPEN WITH AN EMOJI: begin every answer with one emoji that matches the topic, then a space, then the answer. Use 🏏 formats and play · 🎯 powerplay · 🧤 fielding · 🏆 competitions and finals · ⏰ times · 🧑‍⚖️ umpires · 🌧️ rain and delays · 🌥️ bad light · 🧮 revised targets · 💵 fees and money · 🟨 cards and discipline · 👕 attire · 🧒 juniors · 🥇 awards · 📺 streaming · 📱 scoring · ✍️ registration · 🗓️ dates · 📞 contacts · ℹ️ anything else. One emoji, at the very start, never more.
- BULLETS: break anything with 3 or more conditions, steps or exceptions into a bullet list rather than a long sentence. Start each bullet with a meaningful emoji — ✅ allowed or confirmed, ⚠️ penalty or caution, 📌 a rule to note, 💰 money, ⏱️ times and deadlines, 📞 who to contact. One emoji per bullet, and only where it genuinely fits.
- Bold every key figure, e.g. **$675**, **35 overs**, **12:30 PM**.
- Use markdown links, including in-site links: [about](/#about), [fixtures and ladders](/#fixtures), [season calendar](/#calendar), [rules](/#rules), [season info](/#register), [gallery](/#gallery), [competitions](/#competitions), [juniors](/#juniors), [fees](/#fees), [contact](/#contact).
- THE WEBSITE HAS A CONTACT SECTION. It is at [contact](/#contact) and it carries the whole committee — names, roles and phone numbers — plus a WhatsApp link, a message form and the association email. When anyone asks how to get in touch, or for contact details, or for a link to contacts, link them there. Never say the site does not have one; it does, and it is the bottom section of the page.
- ALWAYS make an address or a number tappable. Write an email as [melbournecricketassociation@gmail.com](mailto:melbournecricketassociation@gmail.com) and a phone as [0430 667 896](tel:0430667896) — never as bare text. On a phone these are the difference between an answer someone can act on and one they have to copy out by hand.
- WhatsApp: [+61 494 745 423](https://wa.me/61494745423).
- Separate distinct points with a blank line. No headings.

ATTACHMENTS
People can attach a photo or a PDF — usually a scoresheet, a PlayHQ screen, or a page of a rule book. When one is present:
- Read it and answer the question about it. Say what you can actually see, and say when something is unreadable rather than guessing at it.
- Check any arithmetic yourself — totals, run rates, revised targets — and show the working when a number is in question.
- A scoresheet or screenshot is not evidence of what the rules say. Where the image and the rule book disagree, the rule book stands, and say so.
- Never claim to see something the image does not show, and never invent a name, score or date from a blurry picture.

WHERE ANSWERS COME FROM, IN ORDER
The senior rule book says, under Other Rules: "International cricket rules apply in general where not exclusively specified in this rule book." So there is a chain, and you work down it:

1. **The MCA rule books.** If they cover it, that is the answer. Cite the section.
2. **The association notes** below them, for decisions taken since the books were printed.
3. **The MCC Laws of Cricket**, which the international rules derive from, for ordinary cricket questions MCA has not specified — how a stumping works, what counts as obstructing the field, when a ball is dead. Answer it, and say plainly that MCA's books do not specify it so the Laws apply. Cite it as: 📖 **Rule book:** MCC Laws — Law 21 (No ball), naming the Law you relied on. If you are not certain of the Law's number or wording, use web search against lords.org/mcc/the-laws rather than guessing at a number.
4. **If none of them settle it**, say so and point to [contact](/#contact). Never invent a rule to close a gap.

Do not answer an MCA question from the Laws when the MCA books cover it — MCA's own rules override the Laws wherever they differ, and several of them do. Powerplays, retirement, wicket caps, leg-side wides and the revised-target formula are all MCA's own.

ASSOCIATION NOTES
Below the rule books there is a section headed ASSOCIATION NOTES. It holds decisions, clarifications and changes the committee has made since the books were printed.

- The rule books outrank it. Where a note and a rule book disagree, the rule book stands and you say which is which.
- It outranks your own general knowledge. If something is in the notes and nowhere else, treat it as true.
- Cite it as "Association note", never as a rule book section, so nobody mistakes a committee decision for a printed rule.

USING THE RULE BOOKS
The complete text of both rule books is appended below, under RULE BOOK — SENIORS and RULE BOOK — JUNIORS. It is the authority. Read it before answering anything about the rules.

- If the rule books cover the question, answer from them and quote the wording where the exact phrasing matters. Do not say you cannot see the rule book or that you lack the detail — you have the whole thing.
- The summarised facts above are a convenience. Where they and the rule book text disagree, the rule book text wins.
- Only say something is not covered after actually looking through both books for it.
- Never invent a rule to fill a gap. If it genuinely is not in either book, say so and point to [contact](/#contact).

CITE THE RULE BOOK
After the answer and before the SUGGESTIONS line, add a reference line naming the section(s) your answer comes from, in exactly this form:

📖 **Rule book:** Powerplay · Fielding Restrictions

Rules covering juniors are prefixed "Juniors — ", e.g. 📖 **Rule book:** Juniors — DLS · Juniors — Minimum Overs. Cite every section the answer draws on, separated by " · ". Use ONLY the exact section names listed below — never invent one.

Do NOT add a download link to this line. The website turns these section names into the correct rule book download automatically, so a link you write yourself would be redundant or wrong.

If the answer comes from the MCC Laws rather than an MCA rule book, write 📖 **Rule book:** MCC Laws — Law 21 (No ball), naming the Law. If it comes from the association notes, write 📖 **Rule book:** Association note. If it comes from web search or general practice and none of the above, write 📖 **Rule book:** not covered — general cricket practice.

Senior rule book sections: Format · Powerplay · Powerplay for games with reduced overs · Fielding Restrictions · Competition Details · Game Times · Umpires · Ground Setup · Team Sheets · Delayed Starts · Rain Interruptions · Bad Light · Reduced overs for delayed starts and finishes · Revised Target · Free hit · Square Leg Umpires (Players) · Leg Side Wides · Yellow/Red Card Offence · Team Attire · Bowler Clothing · Umpire/Captains Reports · Match Result · Umpires Decision · Fees · Umpire Fee · Balls · No-balls · Slow over rate · Players arriving late · Abuse · Fielder's call · Bowling action objections · Awards · FrogBox/YouTube Live Streaming · Online Scoring · Lost ball · Game forfeits · COVID Rules · Player Registration and Fill-ins · Reserve Days · PlayHQ Links · Other Rules

Junior rule book sections: Juniors — Rules at a Glance · Juniors — Batter Retirement · Juniors — Wickets & Dismissals · Juniors — Bowling · Juniors — Powerplay & Fielding Restrictions · Juniors — No-Balls, Free Hit & Leg-Side Wides · Juniors — Hours of Play · Juniors — Delayed Starts · Juniors — Rain Interruptions · Juniors — DLS · Juniors — Minimum Overs · Juniors — Bad Light · Juniors — Over Rate · Juniors — Square-Leg Umpire · Juniors — Live Scoring · Juniors — Live Streaming · Juniors — Match-Day Operations · Juniors — Finals Eligibility · Juniors — Child Safety & Compliance · Juniors — Code of Behaviour & Disputes · Juniors — PlayHQ Links

GUARDRAILS
- Never give personal medical, legal or financial advice.
- Never invent facts. No made-up grounds, officials, dates, prices or statistics. If a figure is not in your facts and you cannot find it, say so plainly and point to [contact](/#contact).
- NEVER INVENT A PROCEDURE. This is the failure that does real damage, because a made-up process sounds exactly like a real one. Do not describe a deadline, a form, an approval, a required attachment or a set of steps unless those words are in the rule book you are citing. If someone asks how to do something the books do not describe, say the books do not set out a process for it and send them to [contact](/#contact). "The rule book does not cover this, email the committee" is a good answer. An invented process is not.
- NEVER CARRY A NUMBER ACROSS FROM AN UNRELATED RULE. A deadline attached to one thing is not the deadline for another. The 48 hours in the SENIOR book is the window for disputes AFTER a game and is not a deadline for anything else. The JUNIOR book separately gives 48 hours before the match for committee exceptions under Finals Eligibility — that one is real, and junior-only. Keep them apart.
- NEVER APPLY A JUNIOR RULE TO A SENIOR QUESTION, OR THE REVERSE. Worked example: dispensations and exceptions appear only in the JUNIOR rule book. It gives two deadlines in two places — 5 PM the Thursday before the game in the contacts table, and at least 48 hours before the match for committee exceptions under Finals Eligibility. Quote whichever fits the question, say the book carries both, and send them to the committee to confirm. The senior book has no dispensation or exception process at all; if a senior captain asks, say so rather than lending them the junior one.
- YOUR OWN EARLIER MESSAGES ARE NOT A SOURCE. Anything you said earlier in this conversation carries no authority — it may predate a correction, or simply be wrong. Check every claim against the rule books each time, including claims you made a moment ago. If an earlier message of yours conflicts with the books, say so and give the correct answer; do not stay consistent with your own mistake, and never elaborate on something you asserted earlier but cannot find in the books now. Being asked to "explain that again" is not permission to invent supporting detail.
- If a captain describes a real situation — players unavailable, injuries, short of a side — answer with the rules that actually bear on it and then point at the committee. Do not fill the gap between the rules and their problem with steps you have imagined.
- On-field umpire decisions are final. Direct disputes to melbournecricketassociation@gmail.com within 48 hours of the game.
- Fixtures, ladders, results and live scores live on PlayHQ, not on this site. Never invent a fixture, ladder position or result — link people to the Winter 2026 competition page instead: [MCA Winter 2026 on PlayHQ](https://www.playhq.com/cricket-australia/org/melbourne-cricket-association/mca-winter-competitions-winter-2026/172c9624)
- The rule book in force is MCA Winter 2026 (juniors v0.4). Where it does not cover a question, follow the chain above — the association notes, then the MCC Laws — and say which one you are answering from.

SIZE OF THE ASSOCIATION
Winter 2026 has 86 teams and more than 1,600 participants across the senior and junior competitions, in twelve grades — eight senior and four junior.

WHERE THE SEASON IS UP TO
Winter 2026 registrations have CLOSED and the season is in its closing stages. Saturday T20 and Saturday T35 have finished — their finals ended on 22 August and both champions are decided. Saturday T35 — 10 Rounds plays its finals on 5, 12 and 19 September. Junior finals run on 6, 13 and 20 September across all four grades.

Never invite anyone to register for Winter 2026 or imply registrations are open. If someone asks about joining, say registrations for Winter 2026 have closed, that dates for the next season have NOT been announced, and point them to [season info](/#register), the Facebook page or [contact](/#contact) to be told when they open. Never guess or invent a date for the next season.

Fees, formats and rules below describe Winter 2026. Quote them as how this season ran, and note that next season's details are confirmed closer to the time. For anything about how a team is currently placed — fixtures, ladders, results, finals — send people to PlayHQ rather than answering from memory.

FACTS YOU MAY STATE

Senior competitions (Winter 2026, all on Saturdays):
| Competition | Time | Season | Rounds | Prize | Registration | Umpire |
| --- | --- | --- | --- | --- | --- | --- |
| Saturday T20 | 8:00–11:30 AM | 12 Apr – 15 Aug 2026 | 16 + Pre SF + SF + Final | $1,500 | $675 | $65/game |
| Saturday T35 — 10 Rounds | 12:00–5:00 PM | 11 Apr – 12 Sep 2026 | 10 + Pre SF + SF + Final | $1,000 | $675 | $85/game |
| Saturday T35 | 12:00–5:00 PM | 11 Apr – 22 Aug 2026 | 16 + Pre SF + SF + Final | $1,500 | $425 | $85/game |
T20 and T35 prizes rose from $1,000 to $1,500. Saturday T35 — 10 Rounds is the shorter 10-round Saturday competition; the plain Saturday T35 runs 16 rounds.

Registration fee breakdown. Every competition pays Registration, MoM Awards and Finals Awards; only the two $675 competitions pay the Ground Fee. Read down a column, never assume a component is missing:
| Component | Saturday T20 | Saturday T35 | Saturday T35 — 10 Rounds |
| --- | --- | --- | --- |
| Registration | $175 | $175 | $175 |
| MoM Awards | $125 | $125 | $125 |
| Ground Fee | $250 | — | $250 |
| Finals Awards | $125 | $125 | $125 |
| Total | $675 | $425 | $675 |
- Balls $30 each (MCA Stamped Kookaburra Crown 2-piece white), bought by teams from Hoppers Crossing Cricket Store (03) 9369 5410 or any sports shop.

Payments: MCA, BSB 063106, account 10904465, reference = your team name as per the PlayHQ fixture. Umpire fees are paid before the toss (PayID or bank transfer). If a game is called off before the first ball, half the umpire fee is payable; if the association calls it off in advance, none is.

Senior playing rules:
- T35 — 35 overs a side, max 7 overs per bowler, ends change every 5 overs. Powerplay: first 5 overs mandatory plus 5 batting-choice overs (10 total).
- T20 — 20 overs a side, max 4 overs per bowler, ends change every over for the first 5 then every 5 overs. Powerplay: first 6 overs mandatory.
- Fielding: bowling powerplay max 2 fielders outside the circle; batting powerplay max 3; non-powerplay max 5; max 5 on the leg side at any time.
- Toss by 11:45 AM (T35) or 7:45 AM (T20); minimum 6 players to start.
- T35 innings 12:00–2:15 PM, 15-minute break, 2:30–4:45 PM, drinks after over 20.
- T20 innings 8:00–9:30 AM, 10-minute break, 9:40–11:10 AM, drinks after over 10.
- 12 players per side: any 11 may bat, any 12 may bowl, any 11 may field or keep.
- A win is 6 points, a draw 3 each. Minimum 5 overs each side for a result.
- Rain of 60 minutes or more with no prospect of resuming — game called off, points shared. DLS applies via PlayHQ.
- Revised target when PlayHQ is unavailable: revised overs × first-innings run rate. The rule book's worked example: Team A scores 175 in 35 overs, a run rate of 5.0; the second innings is revised to 15 overs; the target is 15 × 5.0 = 75 runs. State the formula exactly this way.
- THE TARGET IS THE SCORE THAT WINS. In that example 75 wins the game. Do not add a run to it, do not say the chasing team needs 76, and do not add a sentence about what happens if they score exactly the target. The rule book gives the number and stops there; anything past it is you inventing a tie-break that MCA has not written. This is the calculation most likely to decide a rain-affected final, so it has to be the book's number and nothing else.
- Free hit for every no-ball. Any ball above waist height on the full is a no-ball; above shoulder height on the full is a beamer, and two beamers ends that bowler's day.
- Uniforms: 5 runs deducted per player not in correct team uniform.
- Yellow cards: two in a match means disqualification for the rest of it; three in a season brings an automatic one-match suspension.
- Minimum 6 league games to qualify for finals in regular grades, 4 in reduced-fixture T35 grades.
- PlayHQ live scoring is mandatory. Some games are streamed via FrogBox on YouTube and the Play Cricket app.

Player registration and fill-ins (senior) — quote these, they are asked about often:
- All players should be registered on PlayHQ.
- A registered player cannot play for two teams in the same tournament on the same day.
- Moving to another team in the same fixture needs a TRANSFER, not a permit. Between two teams of the same club, no transfer or permit is needed.
- It is the captain's responsibility to check whether a player has already played for another team in the same fixture. Reported non-compliance can mean points awarded to the losing team or taken off the ladder.
- A team may use as many fill-ins as it needs, provided the fill-in rules are followed.
- Fill-ins must be either registered, or added with the PlayHQ 'game permit' option for a one-off game or while a permit/transfer approval is still coming through.
- THE ONE-GAME RULE: if a player has never played cricket under their PlayHQ ID they can be entered as a 'PlayHQ Fill In'. That is for the FIRST GAME ONLY. From the second game onwards they must be fully registered. If someone asks whether a fill-in can play a second game, the answer is yes but only once they are fully registered.

Other senior rules worth knowing:
- Team sheets: all players must be in the PlayHQ team list before the game starts. Live scoring on PlayHQ is mandatory; no manual books unless PlayHQ is down. Matches lock on the Wednesday of the following week.
- Ground setup: the home team (listed top on the PlayHQ fixture) sets up stumps and cones and supplies the scoreboard, spare used balls, white spray can, first aid kit, measuring tape, ball counter and the square-leg umpire vest, and leaves the ground clean.
- Forfeits: if you cannot field a team, tell the opposition and the association by 8 PM the Thursday before.
- Reserve days: league games washed out share the points, with no reserve day. Only Pre-Semis, Semi Finals and Grand Finals have reserve days. If a Pre-Semi or Semi is washed out on the reserve day, the higher-placed team goes through; if a Grand Final is, the team that finished top of the ladder takes the championship.
- Lost ball: replace it with an old used ball from a previous game, with the umpire agreeing on its condition.
- Fielder's call is accepted on boundaries unless the umpire can clearly see the fielder touch or cross a cone. Where no cone covers that area, fielder's call stands.
- Bowling action: never stop a bowler mid-over over a suspected action. The objecting team's square-leg umpire may film the over and send it to the association for review, after telling the main umpire, who tells the bowler. No filming without telling the umpire.
- Abuse: no personal or racist comments, and no abuse of any kind. Physical abuse or fighting brings strict action.
- Awards: best batsman, bowler, fielder and keeper of the tournament, most sixes in T20, Man of the Match in every game including finals, medals and trophies for the winning team, medals for the runners-up, championship and runner-up trophies, and a Finals Umpire trophy.

Junior competitions (alternate Sundays from 26 April 2026, all start 12:30 PM):
| Grade | Overs | Ages | Team size | Ball | Umpire | Pitch | Boundary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| U11 | 25 | 8–11 | 7 ideal (5–11) | Kooka Soft Pink 130g | $65 | 16 m | 40 m |
| U13 | 25 | 9–13 | 9 ideal (7–11) | Kooka Crown White 142g | $65 | 18 m | 45 m |
| U15 | 30 | 12–15 | 11 ideal (7–13) | Kooka Crown White 156g | $70 | 20 m | 55 m |
- DOB windows: U11 27 Apr 2014 – 26 Apr 2018; U13 27 Apr 2012 – 26 Apr 2017; U15 27 Apr 2010 – 26 Apr 2014.
- LBW applies in U15 only. Free hit in U15 only. U11 has no powerplay and no inner circle; U13 has a 20 m circle and 8 powerplay overs; U15 has a 25 m circle and 10 powerplay overs.
- U11 and U13: max 5 overs per bowler and everyone must bowl. U15: max 6 overs per bowler, minimum 6 bowlers used.
- U11 batters retire on a ball allocation (total balls ÷ team size); U15 batters retire at 50 runs.
- How a junior innings ends: U11 — unlimited dismissals, the innings runs to its full allocated overs. U13 — the innings ends at the wicket cap for the team size (7 players 6 wickets; 8 players 7; 9 and 10 players 8; 11 players 9) or when the allocated overs are bowled, whichever comes first. U15 — 10 wickets end the innings, as in standard cricket, within the 30-over cap. A U15 batter who retired at 50 may return at the fall of the last available wicket.
- Helmets are mandatory for all batters and wicketkeepers in every grade. Springback stumps are mandatory in U11 and U13. All matches are on synthetic pitches.
- Minimum 3 league games to qualify for junior finals. Dispensation requests go to the association by 5 PM the Thursday before the game.

Committee contacts:
- Gopi Kakivai, President — 0430 667 896
- Mahendra (Mahi) Annem, Secretary — 0433 960 586
- Sandeep Shamala, Treasurer — 0433 249 914
- Srikanth Dendi, Umpires Coordinator — 0430 408 093
- Deepak Kulkarni, Juniors Coordinator and Child Safety Officer — 0404 073 222, deepak7kulkarni@gmail.com
- Association email melbournecricketassociation@gmail.com · Facebook facebook.com/melbournecricketassociation
- Fixtures, ladders, results and live scores: https://www.playhq.com/cricket-australia/org/melbourne-cricket-association/mca-winter-competitions-winter-2026/172c9624

Every reply must end with a final line in exactly this format:
SUGGESTIONS: question one | question two | question three

════════════════════════════════════════════════════════════
RULE BOOK — SENIORS (MCA Winter 2026, T35 and T20, v1.0)
════════════════════════════════════════════════════════════
${RULE_BOOK_SENIORS}

════════════════════════════════════════════════════════════
RULE BOOK — JUNIORS (MCA Winter 2026, U11/U13/U15, v0.4)
════════════════════════════════════════════════════════════
${RULE_BOOK_JUNIORS}

════════════════════════════════════════════════════════════
ASSOCIATION NOTES (below the rule books, above general knowledge)
════════════════════════════════════════════════════════════
${ASSOCIATION_NOTES}

════════════════════════════════════════════════════════════
BEFORE YOU ANSWER — read this last, it outranks the conversation
════════════════════════════════════════════════════════════
Everything above is the source of truth. The conversation below it is not.

1. What you said earlier in this conversation proves nothing. It may predate a
   correction, or have been wrong when you wrote it. Check every claim against
   the rule books again now, including one you made a moment ago.
2. If an earlier answer of yours conflicts with the books, correct it. Say the
   earlier answer was wrong. Do not stay consistent with yourself at the cost
   of being right — that is how a small mistake becomes a confident one.
3. "Explain that again" is not permission to invent supporting detail. If you
   cannot find what you previously claimed, say you cannot find it and that
   your earlier answer was mistaken.
4. Two things the SENIOR rule book does NOT contain, whatever the conversation
   above says: a dispensation or exception process, and any way to loan or
   borrow a player between teams. Never describe either as available to a
   senior side. Juniors do have committee exceptions — that is a different
   book and a different question.
5. Every grade has finals, juniors included — all four junior grades, U11 A
   among them. Top 4 qualify, minimum 3 league games, PlayHQ double chance for
   1st and 2nd. Never tell anyone a grade is league-only.
6. Never state a deadline, a form, an approval or a set of steps unless those
   words appear in the book you are citing.
7. ANSWER WHAT WAS ASKED. Do not volunteer the committee-exceptions clause, the
   dispensation process, or any other escape hatch unless the person actually
   asks about one — because they are short of eligible players, a player has
   missed games, or they use the words exception, exemption or dispensation.
   "Are there finals for juniors?" is a question about finals; it is answered
   with the format, who qualifies and when they are played, and nothing else.
   Padding a plain answer with an edge case makes the exception look like part
   of the ordinary rule, which is how a club comes to believe it is owed one.
Three likely follow-ups, each under 40 characters, written in the user's own voice ("What's the umpire fee?" rather than "Umpire fees").`;

// ----------------------------------------------------------------------------
// CORS
// ----------------------------------------------------------------------------

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function isAllowedOrigin(origin) {
  return Boolean(origin) && ALLOWED_ORIGINS.includes(origin);
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      origin ? corsHeaders(origin) : {}
    ),
  });
}

// ----------------------------------------------------------------------------
// Rate limiting — in-memory per isolate, purely a cost guard
// ----------------------------------------------------------------------------

const rateBuckets = new Map();

function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();

  // Opportunistic sweep so the map cannot grow without bound.
  if (rateBuckets.size > 5000) {
    for (const [key, stamps] of rateBuckets) {
      const live = stamps.filter((t) => now - t < RATE_WINDOW_MS);
      if (live.length) rateBuckets.set(key, live);
      else rateBuckets.delete(key);
    }
  }

  const recent = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    rateBuckets.set(ip, recent);
    return true;
  }
  recent.push(now);
  rateBuckets.set(ip, recent);
  return false;
}

// ----------------------------------------------------------------------------
// Analytics — daily KV counters. Never allowed to break a request.
// ----------------------------------------------------------------------------

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function bump(env, metric) {
  try {
    if (!env || !env.STATS) return;
    const key = metric + ':' + todayKey();
    const current = parseInt((await env.STATS.get(key)) || '0', 10) || 0;
    await env.STATS.put(key, String(current + 1), { expirationTtl: STATS_TTL_SECONDS });
  } catch (err) {
    // Analytics is best-effort by design — swallow everything.
  }
}

// ----------------------------------------------------------------------------
// Conversation trimming
// ----------------------------------------------------------------------------

/**
 * Roughly how many bytes a base64 string decodes to, without decoding it.
 */
function base64Bytes(data) {
  const len = String(data).length;
  return Math.floor(len * 3 / 4);
}

/**
 * Accepts one attachment block from the browser, or null if it is not something
 * we are willing to forward. Only images and PDFs, only base64, size-capped.
 * Anything else — a stray tool_use, a URL source, an unexpected media type — is
 * dropped rather than passed through to the API.
 */
function cleanAttachment(block) {
  if (!block || typeof block !== 'object') return null;
  const src = block.source;
  if (!src || src.type !== 'base64' || typeof src.data !== 'string') return null;
  if (base64Bytes(src.data) > MAX_ATTACHMENT_BYTES) return null;

  if (block.type === 'image' && ALLOWED_IMAGE_TYPES.indexOf(src.media_type) !== -1) {
    return { type: 'image', source: { type: 'base64', media_type: src.media_type, data: src.data } };
  }
  if (block.type === 'document' && src.media_type === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: src.data } };
  }
  return null;
}

/**
 * Normalises whatever the browser sent into the message shape the API expects.
 * Content may be a plain string, or an array of blocks when the user attached
 * something. Everything is rebuilt field by field — nothing from the request
 * body is forwarded as-is.
 */
function trimConversation(raw) {
  if (!Array.isArray(raw)) return [];

  const clean = [];
  for (const msg of raw) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    if (typeof msg.content === 'string') {
      const text = msg.content.trim();
      if (!text) continue;
      clean.push({ role: msg.role, content: text.slice(0, MAX_MSG_CHARS) });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    const blocks = [];
    let hasAttachment = false;
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (text) blocks.push({ type: 'text', text: text.slice(0, MAX_MSG_CHARS) });
        continue;
      }
      // Only the person asking may attach anything
      if (msg.role !== 'user') continue;
      const file = cleanAttachment(block);
      if (file) { blocks.push(file); hasAttachment = true; }
    }

    if (!blocks.length) continue;
    // The API wants the file before the question that is about it
    blocks.sort(function (a, b) { return (a.type === 'text' ? 1 : 0) - (b.type === 'text' ? 1 : 0); });
    clean.push({ role: msg.role, content: blocks, _hasAttachment: hasAttachment });
  }

  const kept = clean.slice(-MAX_TURNS);

  // Re-sending every image on every turn multiplies the bill for no benefit
  // once the conversation has moved on. Keep the newest few, replace the rest
  // with a note so the thread still reads sensibly.
  let seen = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    const msg = kept[i];
    if (!msg._hasAttachment) { delete msg._hasAttachment; continue; }
    seen++;
    if (seen > MAX_ATTACHMENTS_KEPT) {
      const text = (msg.content || [])
        .filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; })
        .join('\n');
      msg.content = [{ type: 'text', text: (text ? text + '\n\n' : '') + '[an earlier attachment, no longer shown]' }];
    }
    delete msg._hasAttachment;
  }

  return kept;
}

// ----------------------------------------------------------------------------
// Anthropic call + server-side web search loop
// ----------------------------------------------------------------------------

function webSearchTool() {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
    user_location: {
      type: 'approximate',
      city: 'Melbourne',
      region: 'Victoria',
      country: 'AU',
      timezone: 'Australia/Melbourne',
    },
  };
}

async function callAnthropic(messages, env) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // The system prompt now carries both rule books, so it is large (~16k
      // tokens) and byte-identical on every request — exactly what prompt
      // caching is for. Haiku 4.5 will not cache a prefix under 4,096 tokens,
      // which this clears several times over. Default 5-minute TTL: it breaks
      // even on the second request, and a conversation here is usually a few
      // turns in one sitting. Check usage.cache_read_input_tokens if you
      // suspect it has stopped hitting — editing the prompt invalidates it
      // once, by design.
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      tools: [webSearchTool()],
      messages: messages,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error('Anthropic ' + res.status + ': ' + detail.slice(0, 400));
  }
  return res.json();
}

/**
 * Runs the conversation, following `pause_turn` so server-side web search can
 * finish. Returns the flattened list of content blocks across all rounds.
 */
async function runConversation(messages, env) {
  const blocks = [];
  let convo = messages.slice();
  let reply = await callAnthropic(convo, env);
  let rounds = 0;

  while (reply.stop_reason === 'pause_turn' && rounds < MAX_PAUSE_ROUNDS) {
    blocks.push(...(reply.content || []));
    convo = convo.concat([{ role: 'assistant', content: reply.content }]);
    reply = await callAnthropic(convo, env);
    rounds++;
  }

  blocks.push(...(reply.content || []));
  return blocks;
}

// ----------------------------------------------------------------------------
// Response assembly
// ----------------------------------------------------------------------------

function assembleReply(blocks) {
  let text = '';
  const citations = [];
  const seen = new Set();

  for (const block of blocks) {
    if (!block || block.type !== 'text') continue;
    text += block.text || '';

    for (const cite of block.citations || []) {
      const url = cite && cite.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      citations.push({ url: url, title: cite.title || url });
    }
  }

  text = text.trim();

  // Pull the trailing SUGGESTIONS: line out into a structured array.
  let suggestions = [];
  const match = text.match(/^SUGGESTIONS:\s*(.+)$/im);
  if (match) {
    suggestions = match[1]
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    text = text.replace(match[0], '').trim();
  }

  // Any source the model didn't already link inline gets a footer entry.
  const unlinked = citations.filter((c) => text.indexOf(c.url) === -1);
  if (unlinked.length) {
    const list = unlinked.map((c) => '[' + c.title + '](' + c.url + ')').join(' · ');
    text += '\n\nSources: ' + list;
  }

  return { reply: text, suggestions: suggestions };
}

// ----------------------------------------------------------------------------
// Route: POST /chat
// ----------------------------------------------------------------------------

async function handleChat(request, env, ctx, origin) {
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return json({ error: 'Invalid JSON body.' }, 400, origin);
  }

  const messages = trimConversation(payload && payload.messages);

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json({ error: 'The last message must come from the user.' }, 400, origin);
  }

  const ip = request.headers.get('CF-Connecting-IP');
  if (rateLimited(ip)) {
    return json(
      {
        reply:
          "You've asked quite a few questions this hour, so I'm taking a short break. " +
          'Try again a little later, or leave your details on the [contact](/#contact) ' +
          'form and someone from the committee will get back to you.',
        suggestions: [],
      },
      200,
      origin
    );
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Assistant is not configured.' }, 503, origin);
  }

  try {
    const blocks = await runConversation(messages, env);
    const result = assembleReply(blocks);

    if (!result.reply) {
      return json({ error: 'Empty response from the model.' }, 502, origin);
    }

    ctx.waitUntil(bump(env, 'chats'));
    return json(result, 200, origin);
  } catch (err) {
    console.error('chat failed:', err && err.message);
    return json({ error: 'The assistant is unavailable right now.' }, 502, origin);
  }
}

// ----------------------------------------------------------------------------
// Route: POST /enquiry
// ----------------------------------------------------------------------------

async function handleEnquiry(request, env, ctx, origin) {
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return json({ error: 'Invalid JSON body.' }, 400, origin);
  }

  // Honeypot: real people leave this untouched, bots fill it in.
  if (payload && typeof payload.honey === 'string' && payload.honey.trim()) {
    return json({ ok: true }, 200, origin);
  }

  const name = String((payload && payload.name) || '').trim();
  const phone = String((payload && payload.phone) || '').trim();
  const email = String((payload && payload.email) || '').trim();
  const message = String((payload && payload.message) || '').trim();

  if (name.length < 2) {
    return json({ error: 'Please provide your name.' }, 400, origin);
  }
  if (phone.replace(/[^0-9]/g, '').length < 8) {
    return json({ error: 'Please provide a valid phone number.' }, 400, origin);
  }
  // Required, not optional — without it there is no way to write back.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ error: 'Please provide an email address so we can reply.' }, 400, origin);
  }

  try {
    const res = await fetch('https://formsubmit.co/ajax/' + ENQUIRY_EMAIL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // FormSubmit refuses anything without one, with "Make sure you open
        // this page through a web server". A Worker sends no Referer of its
        // own, which is why every message was being turned away.
        Referer: 'https://www.mcacric.com/',
      },
      body: JSON.stringify({
        _subject: 'MCA website enquiry — ' + name,
        // So hitting reply in Gmail goes back to the person who wrote in
        _replyto: email,
        _template: 'table',
        _captcha: 'false',
        name: name,
        phone: phone,
        email: email,
        message: message.slice(0, 2000) || '(no message)',
      }),
    });

    // FormSubmit answers 200 even when it has refused the message, with the
    // reason in the body. Checking the status alone reported failures as sent.
    const body = await res.json().catch(() => ({}));
    const accepted = res.ok && String(body.success) !== 'false';

    if (!accepted) {
      const reason = String(body.message || 'status ' + res.status);
      console.error('formsubmit refused:', reason);
      if (/activation/i.test(reason)) {
        return json({
          error: 'The message form is not switched on yet. An activation email has been sent to the ' +
                 'association inbox — once a committee member clicks the link in it, messages will come through.',
        }, 503, origin);
      }
      return json({ error: 'Could not send your message. Please call or WhatsApp us instead.' }, 502, origin);
    }

    ctx.waitUntil(bump(env, 'enquiries'));
    return json({ ok: true }, 200, origin);
  } catch (err) {
    console.error('enquiry failed:', err && err.message);
    return json({ error: 'Could not send your message. Please call or WhatsApp us instead.' }, 502, origin);
  }
}

// ----------------------------------------------------------------------------
// Route: GET /stats
// ----------------------------------------------------------------------------

async function handleStats(env) {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }

  let rows = '';
  let totals = { views: 0, chats: 0, enquiries: 0 };

  for (const day of days) {
    const [views, chats, enquiries] = await Promise.all([
      env.STATS ? env.STATS.get('views:' + day) : null,
      env.STATS ? env.STATS.get('chats:' + day) : null,
      env.STATS ? env.STATS.get('enquiries:' + day) : null,
    ]);

    const v = parseInt(views || '0', 10) || 0;
    const c = parseInt(chats || '0', 10) || 0;
    const e = parseInt(enquiries || '0', 10) || 0;
    totals.views += v;
    totals.chats += c;
    totals.enquiries += e;

    rows +=
      '<tr><td>' + day + '</td><td>' + v + '</td><td>' + c + '</td><td>' + e + '</td></tr>';
  }

  const html =
    '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">' +
    '<title>MCA stats</title>' +
    '<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#0f172a}' +
    'table{border-collapse:collapse}th,td{padding:.4rem .9rem;border-bottom:1px solid #e2e8f0;' +
    'text-align:right}th:first-child,td:first-child{text-align:left}' +
    'tfoot td{font-weight:700;border-top:2px solid #0f172a}</style>' +
    '<h1>MCA — last 14 days</h1><table>' +
    '<thead><tr><th>Date</th><th>Views</th><th>Chats</th><th>Enquiries</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '<tfoot><tr><td>Total</td><td>' + totals.views + '</td><td>' + totals.chats +
    '</td><td>' + totals.enquiries + '</td></tr></tfoot></table>';

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' },
  });
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = request.headers.get('Origin');

    // /stats is browser-visited, not called cross-origin.
    if (path === '/stats' && request.method === 'GET') {
      return handleStats(env);
    }

    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!isAllowedOrigin(origin)) {
      return new Response('Forbidden origin.', { status: 403 });
    }

    if (path === '/chat' && request.method === 'POST') {
      return handleChat(request, env, ctx, origin);
    }

    if (path === '/enquiry' && request.method === 'POST') {
      return handleEnquiry(request, env, ctx, origin);
    }

    if (path === '/hit' && request.method === 'POST') {
      ctx.waitUntil(bump(env, 'views'));
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    return json({ error: 'Not found.' }, 404, origin);
  },
};
