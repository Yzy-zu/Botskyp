import type { Response } from './protocol.js';
export function formatResponse(r:Response):string{
  if(!r.ok){
    if(r.code==='unavailable' && r.action==='backup')return 'Respaldo no realizado: requiere el servidor detenido para copiar los mundos de forma consistente. No lo detuve automáticamente.';
    if(r.code==='unavailable' && r.action==='config-set')return 'No cambié la propiedad: está controlada por el entorno del contenedor o no está disponible. Requiere configuración de infraestructura revisada.';
    const errors={busy:'Hay una operación o backup remoto en curso.',rejected:'El wrapper rechazó la solicitud.',failed:'La operación falló; revisa el estado antes de intentarlo de nuevo.',uncertain:'El resultado es incierto. No se repetirá la acción automáticamente.',offline:'El servidor está detenido; esta acción requiere que esté en línea.',unavailable:'La capacidad no está disponible de forma segura en redspi.',conflict:'El identificador ya pertenece a otra solicitud.',ok:''};
    return `Minecraft: ${errors[r.code]}`;
  }
  const d=r.data as Record<string,unknown>;
  if(['status','players','start','stop','restart'].includes(r.action)){
    const online=d['online']===true;
    let text=`Minecraft en redspi: ${online?'online':d['running']?'contenedor activo, Bedrock aún no responde':'offline'}.`;
    if(d['running'])text+=` Uptime del contenedor: ${d['uptimeSeconds']} s.`;
    if(d['players']!==null)text+=` Jugadores: ${d['players']}/${d['maxPlayers']}.`;
    if(r.action==='players')text+=Array.isArray(d['names'])?` ${d['names'].join(', ') || 'Ninguno conectado.'}`:' Nombres no disponibles con evidencia actual.';
    if(r.action==='start' && !online)text+=' No puedo confirmar el inicio de Bedrock.';
    if(r.action==='restart')text+=' Reinicio del contenedor comprobado; el estado de Bedrock es el indicado arriba.';
    return text;
  }
  if(r.action==='backup')return `Respaldo verificado: ${d['file']}; ${d['bytes']} bytes; SHA-256 ${d['sha256']}.`;
  if(r.action==='config-set')return `Propiedad guardada: ${d['key']}=${d['value']}. Requiere reiniciar; todavía no se aplicó al proceso activo.`;
  if(r.action==='console')return `Comando de Minecraft aceptado. Salida observada: ${d['output'] || 'sin respuesta verificable; no confirmo su efecto.'}`;
  if(r.action==='config-get')return Object.entries(d['properties'] as Record<string,string>).map(([k,v])=>`${k}=${v}`).join('\n');
  if(Array.isArray(d['items']))return (d['items'] as string[]).join('\n') || 'Sin elementos.';
  return String(d['text'] || 'Sin salida.');
}
