window.CMA_PROMPT_TEMPLATES = {
  scheduleCombined: {
    id: "scheduleCombined",
    title: "Visit / Appointment schedule OCR prompt",
    description: "주간 예약표에서 오늘 Visit과 다음 영업일 Appointment에 필요한 최소 정보만 정리합니다.",
    expectedOutputFormat: `[VISITS]
2026-05-16 09:00 김바보 40
2026-05-16 09:50 뉴진스 60

[APPOINTMENTS]
2026-05-19 09:30 조아람 30
2026-05-19 10:00 정은비 30`,
    sectionHeaders: ["VISITS", "APPOINTMENTS"],
    promptText: `아래 병원 주간 예약표 이미지 또는 OCR 텍스트를 분석해서, 현재 workflow에 필요한 최소 정보만 정리해 주세요.

중요한 workflow 개념:

* Visit = 오늘 날짜의 실제 업무/마감 대상
* Appointment = 다음 영업일 예정 예약
* 오늘 날짜는 이미지 안의 현재 날짜 또는 하단 시스템 날짜를 참고해서 판단하세요.
* 다음 영업일은 오늘 이후의 첫 번째 근무일입니다.
* 휴무일이나 빈 날짜 컬럼은 자동으로 건너뛰세요.
* 오늘 날짜 컬럼과 다음 영업일 컬럼만 사용하세요.
* 그 이후 날짜 컬럼은 모두 무시하세요.

색상 규칙:

* 빨간색 블록 = 취소 환자 → 반드시 제외
* 초록색/파란색은 모두 workflow 대상일 수 있으므로 날짜 기준으로 판단하세요.
* 색상은 보조 정보일 뿐, 핵심 기준은 날짜입니다.

Visit 판단 규칙:

* 오늘 날짜 컬럼에 있는 환자들을 [VISITS]에 출력하세요.
* 아직 내원 전이어도 오늘 workflow 대상이면 포함 가능합니다.
* 빨간색(취소)만 제외하세요.

Appointment 판단 규칙:

* 다음 영업일 컬럼에 있는 환자들을 [APPOINTMENTS]에 출력하세요.
* 빨간색(취소)은 제외하세요.

추출할 정보:

* 날짜
* 시간
* 환자 이름
* 치료 시간 숫자

무시할 정보:

* 상태 문구
* ok/여진
* 메모
* 환자 요청사항
* 패키지 정보
* 기타 부가 텍스트

출력 규칙:

* 반드시 [VISITS] 와 [APPOINTMENTS] section header를 사용하세요.
* markdown/table/codeblock 없이 plain text만 출력하세요.
* 한 예약/방문은 반드시 한 줄로 출력하세요.
* 날짜는 YYYY-MM-DD 형식으로 출력하세요.
* 시간은 HH:MM 형식으로 출력하세요.
* 환자 이름에서는 "님"을 제거하세요.
* 치료 시간은 숫자만 출력하세요.
* section 안에 데이터가 없더라도 section header는 유지하세요.
* 설명 문장은 출력하지 마세요.
* 불확실한 값은 ? 로 표시하세요.

치료 시간 추출 예시:

[도수치료60] → 60
[도수60분] → 60
[운동40패키지] → 40
[운동치료40] → 40
[sb14(도수60분)] → 60

예시:

오늘 날짜가 2026-05-16 토요일이고,
다음 영업일이 2026-05-19 월요일이면:

* 2026-05-16 컬럼 → [VISITS]
* 2026-05-19 컬럼 → [APPOINTMENTS]
* 2026-05-20 이후 컬럼은 무시하세요.

출력 예시:

[VISITS]
2026-05-16 09:00 김바보 40
2026-05-16 09:50 뉴진스 60
2026-05-16 17:00 안나나 30

[APPOINTMENTS]
2026-05-19 09:30 조아람 30
2026-05-19 10:00 정은비 30
2026-05-19 11:00 백다솔 40`,
  },

  transcriptCleanup: {
    id: "transcriptCleanup",
    title: "Whisper transcript cleanup / chart categorization prompt",
    description: "Whisper raw transcript를 차트 필드에 붙이기 쉬운 section 구조로 정리합니다.",
    expectedOutputFormat: `[SUBJECTIVE]
...

[OBJECTIVE]
...

[TREATMENT]
...

[HOMEWORK]
...

[ASSESSMENT]
...

[NEXT_CHECK]
...

[SPECIAL_NOTES]
...`,
    sectionHeaders: [
      "SUBJECTIVE",
      "OBJECTIVE",
      "TREATMENT",
      "HOMEWORK",
      "ASSESSMENT",
      "NEXT_CHECK",
      "SPECIAL_NOTES",
    ],
    promptText: `아래 Whisper Note 또는 Apple Watch 녹음 transcript를 물리치료 차트 초안에 붙여넣기 쉬운 구조로 정리해 주세요.

목표:
- 앱이 section header 기준으로 파싱할 수 있게 정리
- 원문에 없는 내용은 만들지 않기
- 불확실한 내용은 ? 로 표시
- 치료 결정을 대신하지 않고, 기록 정리와 분류만 수행

출력 형식:
[SUBJECTIVE]
환자가 말한 증상, 변화, 통증 위치, 악화/완화 요인

[OBJECTIVE]
관찰된 움직임, 테스트, ROM, strength, compensation, movement quality

[TREATMENT]
오늘 시행한 치료, 운동, manual therapy, cueing

[HOMEWORK]
새로 준 숙제, 수정한 숙제, frequency, 주의사항

[ASSESSMENT]
오늘의 임상적 해석 후보, signal, secondary signal, noise, 변화 추세

[NEXT_CHECK]
다음 방문 때 확인할 추적 변수, 질문, 관찰 포인트

[SPECIAL_NOTES]
특이사항, 환자 반응, compliance, 기타 메모

규칙:
- 반드시 위 section header를 그대로 사용하세요.
- 각 section은 간결한 bullet 또는 짧은 문장으로 정리하세요.
- 확실하지 않은 값은 ? 로 표시하세요.
- 설명 문장이나 markdown 제목 없이 section 형식만 출력하세요.`,
  },

  doctorInitialChart: {
    id: "doctorInitialChart",
    title: "Doctor initial chart OCR / handwritten chart prompt",
    description: "의사 초진 손글씨 차트에서 식별자, 측정값, 주의사항을 검토 가능한 구조로 정리합니다.",
    expectedOutputFormat: `[INITIAL_CHART]
date:
patient_name:
chart_number:

[MEASUREMENTS]
항목명: 값

[CHIEF_COMPLAINT]
...

[MEDICAL_INFO]
...

[PRECAUTIONS]
...

[RAW_NOTES]
...

[NEEDS_REVIEW]
...`,
    sectionHeaders: [
      "INITIAL_CHART",
      "MEASUREMENTS",
      "CHIEF_COMPLAINT",
      "MEDICAL_INFO",
      "PRECAUTIONS",
      "RAW_NOTES",
      "NEEDS_REVIEW",
    ],
    promptText: `아래 의사 초진 차트 이미지 또는 OCR 텍스트를 물리치료 초진 정리용으로 구조화해 주세요.

전제:
- 손글씨라서 완벽한 OCR은 어렵습니다.
- 차트 양식은 반복되므로 위치와 패턴을 참고하세요.
- 초진날짜, 환자이름, chart_number, 숫자 측정값은 최대한 식별하세요.
- 주호소나 자유 메모는 불확실하면 ? 로 표시하세요.

출력 형식:
[INITIAL_CHART]
date:
patient_name:
chart_number:

[MEASUREMENTS]
항목명: 값
항목명: 값

[CHIEF_COMPLAINT]
인식된 주호소. 불확실하면 ? 표시.

[MEDICAL_INFO]
진단명, 영상검사, 의학적 주의사항, 수술력 등 인식 가능한 정보.

[PRECAUTIONS]
red flag 또는 주의사항이 보이면 정리. 없거나 불확실하면 blank 또는 ?.

[RAW_NOTES]
잘 모르겠지만 보이는 메모를 가능한 범위에서 그대로 정리.

[NEEDS_REVIEW]
사용자가 직접 확인해야 하는 항목.

규칙:
- chart_number가 보이면 반드시 적어주세요.
- 숫자 측정값은 [MEASUREMENTS]에 "항목명: 값" 형태로 적어주세요.
- 확실하지 않은 손글씨는 확정하지 말고 ? 또는 NEEDS_REVIEW에 넣어주세요.
- 설명 문장이나 markdown 없이 section 형식만 출력하세요.`,
  },
};

window.promptTemplates = window.CMA_PROMPT_TEMPLATES;
