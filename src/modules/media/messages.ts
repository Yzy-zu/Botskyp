export function mediaFailure(code:string):string{
  if(code==='ocr_empty')return 'Revisé la imagen pero no encontré texto legible.';
  if(code==='read_empty')return 'Revisé el archivo pero no encontré texto legible.';
  if(code==='qr_empty')return 'Revisé la imagen pero no encontré un código QR legible.';
  if(/size|limit|dimensions/.test(code))return 'El archivo supera los límites de tamaño, duración, páginas o recursos. No se entregó; envía uno más pequeño. No hay subida a Drive en esta fase.';
  if(/timeout/.test(code))return 'Se agotó el tiempo de descarga o procesamiento. No se entregó el resultado.';
  if(/mime|invalid|unsupported|unsafe|source_not_allowed/.test(code))return 'El archivo, URL o conversión no es compatible o no pasó la validación de seguridad. No se entregó.';
  if(code==='not_allowed')return 'El trabajo se canceló porque el módulo o los permisos ya no están habilitados.';
  if(code==='interrupted')return 'El trabajo fue interrumpido repetidamente y no pudo terminar. No se entregó el resultado.';
  return 'No pude completar la descarga o conversión. Puede que el archivo sea inválido o el formato no sea compatible; no se entregó el resultado.';
}
