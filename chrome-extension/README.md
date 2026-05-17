# Clinical Memory Bridge

Clinical Memory Assistant에서 이미 열린 ChatGPT 탭/창을 새로고침 없이 앞으로 가져오기 위한 전용 Chrome/Edge 확장입니다.

## 설치

1. Chrome 또는 Edge에서 `chrome://extensions`를 엽니다.
2. 오른쪽 위 `개발자 모드`를 켭니다.
3. `압축해제된 확장 프로그램 로드`를 누릅니다.
4. 이 폴더(`chrome-extension`)를 선택합니다.
5. Clinical Memory Assistant 페이지를 새로고침합니다.

로컬 `file:///.../index.html`에서 테스트하려면 확장 상세 화면에서 `파일 URL에 대한 액세스 허용`을 켜야 합니다. GitHub Pages 배포 주소에서는 추가 설정 없이 동작합니다.

## 동작

- 열린 ChatGPT 탭/창이 있으면 그 탭을 활성화하고 창을 앞으로 가져옵니다.
- 열린 ChatGPT가 없으면 새 ChatGPT 팝업 창을 엽니다.
- Clinical Memory Assistant의 데이터나 환자 기록을 읽지 않고, 앱에서 보낸 창 전환 요청만 처리합니다.
