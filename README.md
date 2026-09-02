# 스노우베어베이커리 상품 DB

`스노우베어베이커리 상품정보.xlsx` 를 GitHub 기반 DB + 조회/편집 웹으로 옮긴 것.
GitHub Pages 로 서비스되고, 수정·추가·업로드는 GitHub API 로 이 저장소에 바로 커밋된다.

**화면**: https://couplogis.github.io/snowbear-bakery-db/

## 구조

```
index.html              진입화면(필터+리스트) / 상품선택(리스트+상세)
assets/style.css        스타일
assets/app.js           조회 · 편집 · 업로드 · GitHub 커밋
data/schema.json        컬럼 정의와 상세화면 그룹핑
data/products.json      상품 데이터 (정본)
data/materials.json     부자재 마스터 (구매링크 포함)
images/full/*.png       원본 이미지 — 상세화면에서 클릭 확대
images/thumb/*.webp     썸네일 200px — 리스트/상세 미리보기
tools/extract_excel.py  엑셀 → JSON + 이미지 변환기
```

`data/products.json` 한 건의 모양:

```json
{
  "id": "P001",
  "erp_name": "벨지움초콜렛타르트",
  "sale_code": "171DP354",
  "vendor": "선인",
  "storage": "냉동",
  "images_before": ["P001_벨지움초콜렛타르트_before1.png"],
  "images_after":  ["P001_벨지움초콜렛타르트_after1.png"],
  "active": true,
  "updated_at": "2026-09-02T15:35:48+09:00"
}
```

- `id` 는 한 번 부여되면 바뀌지 않는다. 이미지 파일명이 여기에 묶여 있다.
- `active: false` 는 **숨김**이다. 데이터와 이미지는 지우지 않고 목록에서만 뺀다.
  (필터의 `숨김 포함` 을 켜면 다시 보이고, 상세에서 `숨김 해제` 할 수 있다)
- 값이 비어 있는 항목은 키 자체가 없다.

## 웹에서 편집하기 (토큰 등록)

정적 페이지라 저장에는 GitHub 토큰이 필요하다. 화면 우측 상단 **저장설정** 에서 한 번만 등록한다.

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**
2. Repository access 에서 이 저장소만 선택
3. Permissions → Repository permissions → **Contents: Read and write**
4. 발급된 토큰을 [저장설정] 에 붙여넣기

토큰은 브라우저 `localStorage` 에만 저장되며 github.com API 외에는 전송되지 않는다.
브라우저를 바꾸면 다시 등록해야 한다.

수정·추가·업로드는 각각 **커밋 1개**로 반영되고, 이미지는 git blob 해시를 비교해
내용이 바뀐 것만 올린다. Pages 재배포까지 보통 1분 안쪽 걸린다.

## 엑셀 일괄 업로드

상단 **엑셀 업로드** 에 원본과 같은 형식의 xlsx 를 올리면 시트 `상품리스트(이미지)` 를 읽는다.

- 헤더는 **2행**, 데이터는 **3행**부터. A열 `소분전`, B열 `소분후` 의 셀에 박힌 이미지를 그대로 가져온다.
- `실제판매코드` → `푸드레인 판매코드` → `ERP상품명` 순으로 기존 상품을 찾아
  있으면 **갱신**, 없으면 **추가**한다.
- **엑셀에 없는 기존 상품은 지우지 않는다.** 빼고 싶으면 상세에서 숨김 처리한다.
- 엑셀에 이미지가 없는 상품은 기존 이미지를 유지한다.
- 커밋 전에 "몇 건 갱신 / 몇 건 추가"를 먼저 보여준다.

## 로컬에서 다시 만들기

```bash
pip install openpyxl pillow
python tools/extract_excel.py "<엑셀경로>" --out .          # 새로 생성 (덮어씀)
python tools/extract_excel.py "<엑셀경로>" --out . --merge  # 기존과 병합
```

`--merge` 는 웹 업로드와 같은 규칙으로 병합한다. 실행 후 직접 커밋하면 된다.

## 알아둘 점

- 원본 엑셀의 `유통기한` 열은 전부 비어 있어서 컬럼만 남겨 두었다.
- `시식` 은 별점 문자열(`★★★`)이 그대로 들어 있다.
- 상품 115건 중 `소분 후` 이미지가 있는 것은 48건이다.
- 원본 엑셀 `포장방법` 시트는 단순 집계표라 데이터로 옮기지 않았다.
