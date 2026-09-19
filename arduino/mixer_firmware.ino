// Reference copy of the flashed, final firmware — kept here for
// documentation only. Do not edit without re-flashing the Nano; the Rust
// backend's serial parser (src-tauri/src/serial.rs) assumes this exact
// protocol: "K1,K2,K3,K4,X,Y,BTN\n" at 115200 baud, one line every 50ms.

const int knobPins[4] = {A7, A1, A2, A3};
const int RAW_MIN = 0;
const int RAW_MAX = 943;
const int THRESH_HIGH = 700;
const int THRESH_LOW  = 300;

void setup() {
  Serial.begin(115200);
  pinMode(13, INPUT);
}

String axisLabel(int raw, const char* highName, const char* lowName) {
  if (raw >= THRESH_HIGH) return highName;
  if (raw <= THRESH_LOW)  return lowName;
  return "NEUTRAL";
}

void loop() {
  int pct[4];
  for (int i = 0; i < 4; i++) {
    int raw = analogRead(knobPins[i]);
    pct[i] = (i == 3)
      ? map(constrain(raw, RAW_MIN, RAW_MAX), RAW_MIN, RAW_MAX, 0, 100)
      : map(constrain(raw, RAW_MIN, RAW_MAX), RAW_MIN, RAW_MAX, 100, 0);
  }
  int x = analogRead(A4);
  int y = analogRead(A5);
  int btn = digitalRead(13) == LOW ? 1 : 0;

  Serial.print(pct[0]); Serial.print(",");
  Serial.print(pct[1]); Serial.print(",");
  Serial.print(pct[2]); Serial.print(",");
  Serial.print(pct[3]); Serial.print(",");
  Serial.print(axisLabel(x, "RIGHT", "LEFT")); Serial.print(",");
  Serial.print(axisLabel(y, "UP", "DOWN")); Serial.print(",");
  Serial.println(btn);

  delay(50);
}
