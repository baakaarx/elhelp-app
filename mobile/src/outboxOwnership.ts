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
      notice: 'في بيانات معلّقة من نسخة سابقة ومش معروف صاحبها؛ لن نرسلها لحساب قد يكون خطأ. لا تمسح بيانات التطبيق، واطلب مساعدة المكتب لمراجعتها.',
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
      notice: 'في بيانات معلّقة لحساب آخر؛ لن نرسلها بالحساب الحالي. سجّل الدخول بالحساب صاحب البيانات لمزامنتها، ولا تمسح بيانات التطبيق.',
    };
  }
  return { allowed: true };
}
