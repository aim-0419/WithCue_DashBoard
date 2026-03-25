function getFullYearFromTwoDigits(twoDigits) {
  const currentYear = new Date().getFullYear();
  const currentTwoDigits = currentYear % 100;
  return twoDigits <= currentTwoDigits ? 2000 + twoDigits : 1900 + twoDigits;
}

function isValidDateParts(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

export function normalizeBirthDateInput(rawValue) {
  const digits = String(rawValue || "").replace(/\D/g, "").slice(0, 6);

  if (digits.length !== 6) {
    return {
      ok: false,
      digits,
      message: "생년월일 6자리를 입력해 주세요.",
    };
  }

  const yearTwoDigits = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  const fullYear = getFullYearFromTwoDigits(yearTwoDigits);

  if (!isValidDateParts(fullYear, month, day)) {
    return {
      ok: false,
      digits,
      message: "올바른 생년월일 형식이 아닙니다.",
    };
  }

  const normalized = Number(
    `${String(fullYear)}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`,
  );

  return {
    ok: true,
    digits,
    normalized,
    display: `${fullYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function formatBirthDateInput(rawValue) {
  const digits = String(rawValue || "").replace(/\D/g, "").slice(0, 6);

  if (digits.length <= 2) {
    return digits;
  }

  if (digits.length <= 4) {
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }

  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}
