export function normalizeThaiPhone(value: unknown): string {
  let digits=String(value ?? '').replace(/\D/g,'');
  if(digits.startsWith('0066')) digits=digits.slice(4);
  if(digits.startsWith('66') && digits.length>=11) digits=digits.slice(2);
  if(digits.length===9 && /^[1-9]/.test(digits)) digits='0'+digits;
  return digits;
}

export function assertThaiPhone(value: unknown): string {
  const phone=normalizeThaiPhone(value);
  if(!/^0[1-9][0-9]{8}$/.test(phone)) throw new ApiError(400,'INVALID_PHONE','เบอร์โทรไม่ถูกต้อง กรุณากรอกเบอร์ไทย 10 หลัก');
  return phone;
}

export class ApiError extends Error {
  constructor(public status:number,public code:string,message:string){super(message);}
}

export function cleanText(value:unknown,max=500):string {
  return String(value ?? '').trim().slice(0,max);
}
