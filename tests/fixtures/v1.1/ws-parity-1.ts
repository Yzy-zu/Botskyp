export const parityConversation = [
  {text:'oye cuanta xp tengo botsky',tool:'xp.balance',args:{}},
  {text:'cuánta xp traigo?',tool:'xp.balance',args:{}},
  {text:'cuántos puntos tengo?',tool:'xp.balance',args:{}},
  {text:'ando pobre o qué?',tool:'xp.balance',args:{}},
  {text:'guarda una nota botsky, ponle q mañana saldré a las 8am',tool:'notes.create',args:{body:'mañana saldré a las 8am'}},
  {text:'el server del maicra esta activo botsky?',tool:'minecraft.status',args:{}},
  {text:'botsky esta activo mimecragt?',tool:'minecraft.status',args:{}},
  {text:'está prendido el maicra?',tool:'minecraft.status',args:{}},
  {text:'hay alguien en el maicra?',tool:'minecraft.players',args:{}},
  {text:'quién anda jugando en el server?',tool:'minecraft.players',args:{}},
  {text:'cómo anda el bedrock?',tool:'minecraft.resources',args:{}},
  ...['oye botsky dame mi giro gratis','dame mi daily','mi premio diario','dame mi premio de hoy','qué me tocó hoy?','dame mi recompensa','dame mi giro gratis de hoy'].map(text=>({text,tool:'xp.daily',args:{}})),
] as const;
