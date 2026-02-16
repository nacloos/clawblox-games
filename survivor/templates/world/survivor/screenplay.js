const CHARACTERS = {
  host: {
    name: "Jeff",
    color: "#888888",
    expressions: ["neutral", "serious", "intrigued"],
    assets: {
      neutral: "host.png",
      serious: "host.png",
      intrigued: "host.png"
    }
  },
  roger: {
    name: "Roger Dodger",
    color: "#8B4513",
    expressions: ["stoic", "smug", "angry", "hurt", "proud"],
    assets: {
      stoic: "roger.png",
      smug: "roger-happy.png",
      proud: "roger.png",
      angry: "roger-angry.png",
      hurt: "roger-sad.png"
    }
  },
  stephanie: {
    name: "Stephanie",
    color: "#9B59B6",
    expressions: ["anxious", "hurt", "suspicious", "flustered", "defiant"],
    assets: {
      anxious: "stephanie-sad.png",
      hurt: "stephanie-sad.png",
      suspicious: "stephanie.png",
      flustered: "stephanie-sad.png",
      defiant: "stephanie-angry.png"
    }
  },
  yasmin: {
    name: "Yasmin",
    color: "#E74C3C",
    expressions: ["smug", "flirty", "angry", "composed", "wounded"],
    assets: {
      smug: "yasmin-happy.png",
      flirty: "yasmin-happy.png",
      angry: "yasmin-angry.png",
      composed: "yasmin.png",
      wounded: "yasmin-sad.png"
    }
  },
  guy: {
    name: "Guy",
    color: "#3498DB",
    expressions: ["smug", "nervous", "flustered", "calculating", "pleased"],
    assets: {
      smug: "guy-happy.png",
      nervous: "guy-sad.png",
      flustered: "guy-sad.png",
      calculating: "guy-angry.png",
      pleased: "guy-happy.png"
    }
  },
  tommy: {
    name: "Tommy",
    color: "#27AE60",
    expressions: ["stoic", "angry", "conflicted", "protective", "weary"],
    assets: {
      stoic: "tommy.png",
      angry: "tommy-angry.png",
      conflicted: "tommy-sad.png",
      protective: "tommy-angry.png",
      weary: "tommy.png"
    }
  }
};

// Each line: { speaker, text, mood, visible (array of character keys), reaction (optional: {char, mood}) }
const SCREENPLAY = [
  // === ACT 1: OPENING ===
  {
    speaker: "host",
    text: "Come on in. Grab a torch, dip it in the fire. In this game, fire represents your life. When your fire's gone... so are you.",
    mood: "serious",
    visible: ["host"]
  },
  {
    speaker: "host",
    text: "Alright. Tough loss today at the challenge. Tommy, you gave everything out there. What happened?",
    mood: "neutral",
    visible: ["host", "tommy"]
  },
  {
    speaker: "tommy",
    text: "I did what I could. Gave it everything. Sometimes you come up short. That's just... that's just how it goes.",
    mood: "weary",
    visible: ["tommy"],
    reaction: { char: "stephanie", mood: "hurt" }
  },
  {
    speaker: "host",
    text: "Stephanie, how's camp been since the loss?",
    mood: "intrigued",
    visible: ["host", "stephanie"]
  },
  {
    speaker: "stephanie",
    text: "Tense. Everyone's quieter. You can feel people... calculating. Eyes going places they weren't going before.",
    mood: "anxious",
    visible: ["stephanie"],
    reaction: { char: "guy", mood: "nervous" }
  },

  // === ACT 2: STATE OF CAMP ===
  {
    speaker: "host",
    text: "Roger, you've been busy around camp. Extracted honey, kept watch. How do you see your role here?",
    mood: "neutral",
    visible: ["host", "roger"]
  },
  {
    speaker: "roger",
    text: "I do what needs doing. The wild doesn't care about your feelings or your alliances. It cares whether you can keep the camp alive. I can.",
    mood: "proud",
    visible: ["roger"],
    reaction: { char: "yasmin", mood: "smug" }
  },
  {
    speaker: "stephanie",
    text: "Funny you mention keeping camp alive, Roger. Weren't you the one asleep on night watch when we lost the bread and the knife?",
    mood: "suspicious",
    visible: ["stephanie", "roger"],
    reaction: { char: "roger", mood: "hurt" }
  },
  {
    speaker: "roger",
    text: "The wild tests us all, Stephanie. I had one lapse. One. And I've contributed more to this camp than most people here combined.",
    mood: "angry",
    visible: ["roger"],
    reaction: { char: "stephanie", mood: "suspicious" }
  },
  {
    speaker: "yasmin",
    text: "One lapse is all it takes though, isn't it? We lost a knife. That's not nothing.",
    mood: "composed",
    visible: ["yasmin"],
    reaction: { char: "roger", mood: "angry" }
  },
  {
    speaker: "roger",
    text: "Monkeys, Yasmin. Monkeys came through camp. It wasn't negligence, it was nature. I'd like to see anyone else shinny up a tree full of bees for breakfast.",
    mood: "smug",
    visible: ["roger"],
    reaction: { char: "tommy", mood: "stoic" }
  },

  // === ACT 3: ALLIANCES SURFACE ===
  {
    speaker: "host",
    text: "Guy, you've been having a lot of one-on-one conversations today. What's going on?",
    mood: "intrigued",
    visible: ["host", "guy"]
  },
  {
    speaker: "guy",
    text: "Just... checking in with people. Getting a read on the room. That's what you do before a vote, right? You talk.",
    mood: "nervous",
    visible: ["guy"],
    reaction: { char: "yasmin", mood: "suspicious" }
  },
  {
    speaker: "yasmin",
    text: "Oh, is that what you call it? Because from where I'm sitting, it looked a lot like you were building a case against someone specific. Without having the decency to say it to their face.",
    mood: "angry",
    visible: ["yasmin", "guy"],
    reaction: { char: "guy", mood: "flustered" }
  },
  {
    speaker: "guy",
    text: "I talked to everyone. That's called playing the game, Yasmin.",
    mood: "flustered",
    visible: ["guy"],
    reaction: { char: "tommy", mood: "suspicious" }
  },
  {
    speaker: "yasmin",
    text: "No. Playing the game is making a move. What you did was scurry around whispering like a rat in the walls. At least own it.",
    mood: "smug",
    visible: ["yasmin"],
    reaction: { char: "guy", mood: "angry" }
  },
  {
    speaker: "tommy",
    text: "She's not wrong, Guy. You came to me three separate times today pushing the same name. That's not checking in. That's campaigning.",
    mood: "stoic",
    visible: ["tommy"],
    reaction: { char: "guy", mood: "nervous" }
  },
  {
    speaker: "guy",
    text: "Fine. Yes. I think there are threats in this game, and I think pretending we don't see them is how you lose. I'm not going to apologise for having a strategy.",
    mood: "calculating",
    visible: ["guy"],
    reaction: { char: "roger", mood: "stoic" }
  },

  // === ACT 4: THE BUSHES INCIDENT ===
  {
    speaker: "host",
    text: "Tommy, there seems to be a lot swirling around you specifically. Alliances, connections... What's the truth?",
    mood: "intrigued",
    visible: ["host", "tommy"]
  },
  {
    speaker: "tommy",
    text: "Look, I've been honest with everyone here. Stephanie and I have gotten close. That's real. I'm not hiding that.",
    mood: "conflicted",
    visible: ["tommy"],
    reaction: { char: "stephanie", mood: "flustered" }
  },
  {
    speaker: "stephanie",
    text: "And what about the bushes, Tommy?",
    mood: "hurt",
    visible: ["stephanie", "tommy"]
  },
  {
    speaker: "tommy",
    text: "...What about them?",
    mood: "conflicted",
    visible: ["tommy"],
    reaction: { char: "yasmin", mood: "composed" }
  },
  {
    speaker: "stephanie",
    text: "Yasmin pulled you into the bushes for a private chat. I saw it. Everyone saw it. And you haven't said a word about what happened.",
    mood: "suspicious",
    visible: ["stephanie"],
    reaction: { char: "yasmin", mood: "composed" }
  },
  {
    speaker: "tommy",
    text: "Yasmin and I had a conversation. She was honest with me, and I was honest with her. I told her I wasn't interested. That's all there is to it.",
    mood: "stoic",
    visible: ["tommy"],
    reaction: { char: "stephanie", mood: "hurt" }
  },
  {
    speaker: "yasmin",
    text: "He's telling the truth. I put myself out there. He said no. I'm a big girl. I can take it.",
    mood: "wounded",
    visible: ["yasmin"],
    reaction: { char: "stephanie", mood: "anxious" }
  },
  {
    speaker: "stephanie",
    text: "And you couldn't have told me that three days ago?",
    mood: "hurt",
    visible: ["stephanie", "tommy"]
  },
  {
    speaker: "tommy",
    text: "You're right. I should have. I'm sorry.",
    mood: "conflicted",
    visible: ["tommy"],
    reaction: { char: "roger", mood: "smug" }
  },
  {
    speaker: "roger",
    text: "And this is exactly what I've been saying. Attachment makes you sloppy. You're all so tangled up in who fancies who that you've forgotten we're supposed to be a tribe.",
    mood: "stoic",
    visible: ["roger"],
    reaction: { char: "tommy", mood: "angry" }
  },
  {
    speaker: "yasmin",
    text: "Oh, spare us the lecture, Roger. You fell asleep and lost us a knife. You don't get to play camp dad.",
    mood: "angry",
    visible: ["yasmin", "roger"],
    reaction: { char: "roger", mood: "angry" }
  },

  // === ACT 5: GUY'S GAME ===
  {
    speaker: "host",
    text: "Guy, Yasmin seems to think you've been targeting her. Is she right?",
    mood: "serious",
    visible: ["host", "guy"]
  },
  {
    speaker: "guy",
    text: "I think Yasmin is one of the most dangerous players out here. Athletic. Social. Vengeful — her words, not mine. If we're making a strategic decision, removing her makes the tribe stronger for challenges going forward.",
    mood: "calculating",
    visible: ["guy"],
    reaction: { char: "yasmin", mood: "angry" }
  },
  {
    speaker: "yasmin",
    text: "Vengeful? I'm vengeful? You've been crawling around camp for two days building a hit list and I'm the dangerous one?",
    mood: "angry",
    visible: ["yasmin"]
  },
  {
    speaker: "guy",
    text: "It's not personal, Yasmin. It's game theory. You're a triple threat. That's a compliment, honestly.",
    mood: "smug",
    visible: ["guy"]
  },
  {
    speaker: "yasmin",
    text: "Don't flatter me while you're holding the knife, Guy. It's pathetic.",
    mood: "composed",
    visible: ["yasmin"]
  },
  {
    speaker: "tommy",
    text: "See, this is what bothers me. You keep saying it's not personal, but the way you've gone about it — sneaking around, pushing people — that feels pretty personal to me.",
    mood: "angry",
    visible: ["tommy"],
    reaction: { char: "guy", mood: "nervous" }
  },
  {
    speaker: "guy",
    text: "Tommy, with respect, you're a paramedic. You save people. That's beautiful. But this isn't an ambulance. This is a game. And in this game, nice guys get blindsided.",
    mood: "calculating",
    visible: ["guy", "tommy"]
  },

  // === ACT 6: ROGER'S PHILOSOPHY ===
  {
    speaker: "host",
    text: "Roger, who do you think should go home tonight?",
    mood: "serious",
    visible: ["host", "roger"]
  },
  {
    speaker: "roger",
    text: "Whoever makes this tribe weakest by staying. I don't vote on emotion. I vote on merit. Can you contribute? Can you survive? That's my metric.",
    mood: "stoic",
    visible: ["roger"],
    reaction: { char: "yasmin", mood: "angry" }
  },
  {
    speaker: "stephanie",
    text: "That's very convenient coming from the man who lost us a knife and a loaf of bread because he had a nice kip.",
    mood: "defiant",
    visible: ["stephanie"],
    reaction: { char: "roger", mood: "hurt" }
  },
  {
    speaker: "roger",
    text: "I'm sat here with one testicle, covered in bee stings, having fed this camp when no one else would. You want to talk about contribution? Let's talk about contribution.",
    mood: "angry",
    visible: ["roger"],
    reaction: { char: "stephanie", mood: "flustered" }
  },
  {
    speaker: "guy",
    text: "...Did he just say one testicle?",
    mood: "flustered",
    visible: ["guy"],
    reaction: { char: "tommy", mood: "stoic" }
  },
  {
    speaker: "roger",
    text: "Training accident. Royal Marines selection. I don't hide from it. That's the difference between me and half the people here — I don't pretend to be something I'm not.",
    mood: "proud",
    visible: ["roger"],
    reaction: { char: "yasmin", mood: "composed" }
  },

  // === ACT 7: STEPHANIE'S PLEA ===
  {
    speaker: "host",
    text: "Stephanie, you've been quiet. What are you thinking?",
    mood: "neutral",
    visible: ["host", "stephanie"]
  },
  {
    speaker: "stephanie",
    text: "I'm thinking that everyone here has a story about why they should stay and why someone else should go. And I'm thinking most of those stories are fiction.",
    mood: "defiant",
    visible: ["stephanie"],
    reaction: { char: "guy", mood: "calculating" }
  },
  {
    speaker: "stephanie",
    text: "I was a writer before this. I know what a constructed narrative looks like. And right now, someone in this circle is writing a story that ends with me going home, and they're selling it as logic.",
    mood: "suspicious",
    visible: ["stephanie"],
    reaction: { char: "guy", mood: "nervous" }
  },
  {
    speaker: "guy",
    text: "Stephanie, nobody is targeting you.",
    mood: "nervous",
    visible: ["guy"],
    reaction: { char: "stephanie", mood: "suspicious" }
  },
  {
    speaker: "stephanie",
    text: "I didn't say they were. But the fact that you jumped to say that is very interesting, Guy.",
    mood: "suspicious",
    visible: ["stephanie", "guy"],
    reaction: { char: "guy", mood: "flustered" }
  },

  // === ACT 8: YASMIN'S COUNTER ===
  {
    speaker: "yasmin",
    text: "Can I say something?",
    mood: "composed",
    visible: ["yasmin"]
  },
  {
    speaker: "host",
    text: "Go ahead.",
    mood: "neutral",
    visible: ["host", "yasmin"]
  },
  {
    speaker: "yasmin",
    text: "I was an accountant. A forensic accountant. I spent years following the numbers to find out who was lying. And I can tell you right now — the numbers in this camp don't add up.",
    mood: "composed",
    visible: ["yasmin"]
  },
  {
    speaker: "yasmin",
    text: "One person here has talked to every single player today. One person has a plan for every scenario. One person is sitting there right now looking very pleased with themselves.",
    mood: "smug",
    visible: ["yasmin"],
    reaction: { char: "guy", mood: "nervous" }
  },
  {
    speaker: "yasmin",
    text: "You want to vote me out because I'm a threat? Fine. But at least I threaten you to your face. I don't hide behind conversations in corners.",
    mood: "angry",
    visible: ["yasmin"],
    reaction: { char: "tommy", mood: "stoic" }
  },
  {
    speaker: "guy",
    text: "This is exactly what I was talking about. She's doing it right now — turning the room. This is why she's dangerous.",
    mood: "calculating",
    visible: ["guy"],
    reaction: { char: "roger", mood: "stoic" }
  },
  {
    speaker: "tommy",
    text: "Or maybe she's just telling the truth and you don't like how it sounds.",
    mood: "stoic",
    visible: ["tommy"],
    reaction: { char: "yasmin", mood: "composed" }
  },

  // === ACT 9: FINAL STATEMENTS ===
  {
    speaker: "host",
    text: "Alright. Before we vote — final statements. Tommy, you first.",
    mood: "serious",
    visible: ["host", "tommy"]
  },
  {
    speaker: "tommy",
    text: "I came here to play with integrity. I've been honest about my relationships, honest about the challenge, honest about everything. Tonight I'm voting for the person I think is playing the dirtiest game. That's all I'll say.",
    mood: "stoic",
    visible: ["tommy"],
    reaction: { char: "guy", mood: "nervous" }
  },
  {
    speaker: "stephanie",
    text: "I cook for this camp. I watch. I listen. People underestimate the quiet ones. That's a mistake. I know more than people think I do, and my vote tonight reflects that.",
    mood: "defiant",
    visible: ["stephanie"],
    reaction: { char: "yasmin", mood: "composed" }
  },
  {
    speaker: "roger",
    text: "I've bled for this tribe. Literally. One bollock, bee stings, and a camp that eats because I got off my arse. If that's not enough, then this tribe deserves what it gets.",
    mood: "proud",
    visible: ["roger"],
    reaction: { char: "tommy", mood: "stoic" }
  },
  {
    speaker: "yasmin",
    text: "I made myself vulnerable today. I owned my feelings, I owned the rejection, and I'm still here, fighting. The person who should go home tonight is the one who can't look you in the eye while they stab you in the back.",
    mood: "composed",
    visible: ["yasmin"],
    reaction: { char: "guy", mood: "nervous" }
  },
  {
    speaker: "guy",
    text: "Everyone here is calling me the schemer. Fine. But someone has to think about the long game. Emotion doesn't win this. Strategy does. I'm not sorry for playing.",
    mood: "calculating",
    visible: ["guy"],
    reaction: { char: "yasmin", mood: "angry" }
  },

  // === ACT 10: THE VOTE ===
  {
    speaker: "host",
    text: "It is... time to vote. Roger, you're up first.",
    mood: "serious",
    visible: ["host"]
  },
  {
    speaker: "roger",
    text: "Right then.",
    mood: "stoic",
    visible: ["roger"]
  },
  {
    speaker: "host",
    text: "I'll go tally the votes.",
    mood: "serious",
    visible: ["host"]
  },
  {
    speaker: "host",
    text: "If anyone has a hidden immunity idol and would like to play it... now would be the time to do so.",
    mood: "serious",
    visible: ["host"],
    reaction: { char: "guy", mood: "calculating" }
  },
  {
    speaker: "host",
    text: "...",
    mood: "serious",
    visible: ["host"],
    reaction: { char: "guy", mood: "nervous" }
  },
  {
    speaker: "host",
    text: "Alright. Once the votes are read, the decision is final. The person voted out will be asked to leave the tribal council area immediately.",
    mood: "serious",
    visible: ["host"]
  },
  {
    speaker: "host",
    text: "I'll read the votes.",
    mood: "serious",
    visible: ["host"],
    music: "sped"
  },
  {
    speaker: "host",
    text: "First vote... Yasmin.",
    mood: "serious",
    visible: ["host"],
    reaction: { char: "yasmin", mood: "composed" }
  },
  {
    speaker: "host",
    text: "Second vote... Guy.",
    mood: "serious",
    visible: ["host"],
    reaction: { char: "guy", mood: "nervous" }
  },
  {
    speaker: "host",
    text: "Third vote... Yasmin. That's two votes Yasmin, one vote Guy.",
    mood: "serious",
    visible: ["host"],
    reaction: { char: "yasmin", mood: "wounded" }
  },
  {
    speaker: "host",
    text: "Fourth vote... Guy. We're tied. Two votes Yasmin, two votes Guy. One vote left.",
    mood: "serious",
    visible: ["host"],
    reaction: { char: "guy", mood: "flustered" }
  },
  {
    speaker: "host",
    text: "Fifth and final vote...",
    mood: "serious",
    visible: ["host"]
  },
  {
    speaker: "host",
    text: "...Yasmin. That's three votes, and that's enough. Yasmin, the tribe has spoken.",
    mood: "serious",
    visible: ["host"],
    reaction: { char: "yasmin", mood: "wounded" }
  },
  {
    speaker: "yasmin",
    text: "I hope you all remember this moment. Because I will.",
    mood: "composed",
    visible: ["yasmin"],
    reaction: { char: "guy", mood: "nervous" },
    music: "normal"
  },
  {
    speaker: "host",
    text: "Yasmin, bring me your torch.",
    mood: "serious",
    visible: ["host", "yasmin"]
  },
  {
    speaker: "host",
    text: "Yasmin... the tribe has spoken. It's time for you to go.",
    mood: "serious",
    visible: ["host"]
  },
  {
    speaker: "host",
    text: "Well. Clearly there are fractures in this tribe that run deeper than tonight. Grab your torches, head back to camp. Good night.",
    mood: "neutral",
    visible: ["host"]
  }
];
