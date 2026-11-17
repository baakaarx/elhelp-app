export interface OutboxOwnership {
  allowed: boolean;
  notice?: string;
}

/** Never replay or append work under an account other than the one that saved it. */
export function outboxOwnership(ownerId: string | null, userId: string | null, pending: number): OutboxOwnership {
  if (pending === 0) return { allowed: true };
  if (!ownerId) {
    return {
      allowed: false,
      notice: 'هناك بيانات معلّقة من نسخة سابقة ولا نعرف الحساب صاحبها؛ لم نرسلها لتجنب نسبتها لحساب خطأ. سجّل بالحساب الصحيح أو احذف المعلّق بعد التأكد.',
    };
  }
  if (!userId) {
    return {
      allowed: false,
      notice: 'هناك بيانات معلّقة؛ سجّل الدخول بالحساب الذي حفظها لمزامنتها. لم نرسلها إلى حساب غير معروف.',
    };
  }
  if (ownerId !== userId) {
    return {
      allowed: false,
      notice: 'هناك بيانات معلّقة لحساب آخر؛ لم نرسلها إلى حسابك الحالي. سجّل الدخول بالحساب صاحب البيانات لمزامنتها أو احذف المعلّق بعد التأكد.',
    };
  }
  return { allowed: true };
}
