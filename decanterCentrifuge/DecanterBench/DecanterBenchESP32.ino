/**
 * =================================================================================
 *  DECANTER CENTRIFUGE BENCH FIRMWARE — ESP32
 * ---------------------------------------------------------------------------------
 * Target: ESP32 DevKit V1 / any ESP32 with USB-CDC
 *
 * Connects to the Next.js dashboard via Web Serial API (USB).
 * Telemetry frames every 2 s; accepts commands from the dashboard.
 *
 * SENSORS (same as the Mega version):
 *   - 1x Analog 0-5V flow rate transmitter   -> GPIO36 (ADC1_CH0)
 *   - 1x ACS712 (20 A) current sensor        -> GPIO39 (ADC1_CH3)  Bowl
 *   - 1x ACS712 (20 A) current sensor        -> GPIO34 (ADC1_CH6)  Screw
 *   - 1x DS18B20 temperature sensor (1-Wire) -> GPIO4       with 4k7 pull-up
 *   - 2x HC-SR04 ultrasonic sensors          -> GPIO32/33  (oil outlet)
 *                                                GPIO25/26  (pomace outlet)
 *   - 1x Relay module (pump on/off)          -> GPIO27     (active LOW)
 *   - 1x L298N dual H-bridge motor driver    -> Bowl  : PWM=GPIO14, IN1=GPIO12, IN2=GPIO13
 *                                                Screw : PWM=GPIO15, IN3=GPIO16, IN4=GPIO17
 *   - 1x I2C 16x2 LCD (PCF8574 backpack)     -> SDA=GPIO21, SCL=GPIO22
 *   - Built-in status LED                    -> GPIO2
 *
 * REQUIRED LIBRARIES:
 *   - LiquidCrystal_I2C  (Frank de Brabander)
 *   - OneWire            (Paul Stoffregen)
 *   - DallasTemperature  (Miles Burton)
 * =================================================================================
 */

#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// =================================================================================
// 1. PIN ASSIGNMENTS  (ESP32 DevKit)
// =================================================================================
const int PIN_FLOW            = 36;   // ADC1_CH0  (input only, no pull)
const int PIN_BOWL_CURRENT    = 39;   // ADC1_CH3
const int PIN_SCREW_CURRENT   = 34;   // ADC1_CH6

const int PIN_DS18B20         = 4;    // 1-Wire bus

const int PIN_TRIG_OIL        = 32;
const int PIN_ECHO_OIL        = 33;
const int PIN_TRIG_POMACE     = 25;
const int PIN_ECHO_POMACE     = 26;

const int PIN_PUMP_RELAY      = 27;
const int PIN_STATUS_LED      = 2;

// L298N — Motor A = Bowl
const int PIN_BOWL_PWM        = 14;
const int PIN_BOWL_IN1        = 12;
const int PIN_BOWL_IN2        = 13;

// L298N — Motor B = Screw conveyor
const int PIN_SCREW_PWM       = 15;
const int PIN_SCREW_IN1       = 16;
const int PIN_SCREW_IN2       = 17;

// I2C
const int PIN_I2C_SDA         = 21;
const int PIN_I2C_SCL         = 22;

// PWM channels (ESP32 LEDC)
const int BOWL_PWM_CH         = 0;
const int SCREW_PWM_CH        = 1;
const int PWM_FREQ            = 5000;
const int PWM_RESOLUTION      = 8;    // 0-255 like Mega

// =================================================================================
// 2. CALIBRATION CONSTANTS
// =================================================================================
// ESP32 ADC: 12-bit (0-4095), 3.3 V reference.
// The sensors output 0-5 V, so we use a voltage divider or set ADC attenuation to 11 dB
// to read up to ~3.6 V.  If your sensors output 0-5 V, use a voltage divider (2:1)
// and adjust RANGE_V_MAX accordingly.
const float RANGE_V_MAX       = 3.3;   // Max measurable voltage after divider
const int   ADC_RESOLUTION    = 4095;

const float FLOW_MIN_KGH      = 0.0;
const float FLOW_MAX_KGH      = 6000.0;

// Ultrasonic geometry
const float SPEED_OF_SOUND_CM_US = 0.0343;
const float TANK_HEIGHT_CM       = 20.0;
const float OUTLET_LEVEL_MIN     = 0.0;
const float OUTLET_LEVEL_MAX     = TANK_HEIGHT_CM;

// ACS712 20 A: 100 mV/A
const float ACS712_SENSITIVITY_V_PER_A = 0.100;
const float ACS712_ZERO_V              = 2.5;   // VCC/2 at zero current
const unsigned long ACS712_SAMPLE_MS   = 30;

const float MOTOR_SUPPLY_V    = 12.0;

// Relay polarity
const uint8_t RELAY_ON  = LOW;
const uint8_t RELAY_OFF = HIGH;

// Motor speed envelopes (RPM)
const float BOWL_RPM_MIN      = 2500.0;
const float BOWL_RPM_MAX      = 4000.0;
const float SCREW_RPM_MIN     = 2470.0;
const float SCREW_RPM_MAX     = 3990.0;

const float BOWL_NOMINAL      = 3000.0;
const float SCREW_NOMINAL     = 2985.0;
const float BOWL_WATERY       = 2700.0;
const float SCREW_WATERY      = 2680.0;
const float BOWL_THICKER      = 3300.0;
const float SCREW_THICKER     = 3288.0;

// Oil-ring pump hysteresis (cm)
float oilLowSetpoint  = 4.0;
float oilHighSetpoint = 8.0;

// =================================================================================
// 3. TIMING
// =================================================================================
const unsigned long SENSOR_INTERVAL    = 250;
const unsigned long LCD_INTERVAL       = 500;
const unsigned long LCD_PAGE_INTERVAL  = 3000;
const unsigned long TELEMETRY_INTERVAL = 2000;
const unsigned long REMOTE_TIMEOUT     = 10000;
const unsigned long TEMP_REQUEST_MS    = 2000;
const unsigned long TEMP_CONVERSION_MS = 800;

// =================================================================================
// 4. STATE
// =================================================================================
LiquidCrystal_I2C lcd(0x27, 16, 2);
OneWire oneWire(PIN_DS18B20);
DallasTemperature dsSensor(&oneWire);

float flowKgh        = 0.0;
float oilLevelCm     = 0.0;
float pomaceLevelCm  = 0.0;
float tempC          = 25.0;
float bowlCurrentA   = 0.0;
float screwCurrentA  = 0.0;
float totalPowerW    = 0.0;
float specificEnergy = 0.0;
float predictedEff   = 0.0;
bool  pumpOn         = false;

enum PumpMode   { PUMP_AUTO, PUMP_MANUAL };
enum MotorDir   { DIR_FWD, DIR_REV };
enum FeedPreset { FEED_NOMINAL, FEED_WATERY, FEED_THICKER, FEED_REMOTE };

PumpMode   pumpMode  = PUMP_AUTO;
MotorDir   bowlDir   = DIR_FWD;
MotorDir   screwDir  = DIR_FWD;
FeedPreset feedMode  = FEED_NOMINAL;

float bowlRpm  = BOWL_NOMINAL;
float screwRpm = SCREW_NOMINAL;

// DS18B20 async
bool          tempConversionPending = false;
unsigned long tempRequestedAt       = 0;
unsigned long lastTempCycleMs       = 0;

unsigned long lastSensorMs    = 0;
unsigned long lastLcdMs       = 0;
unsigned long lastLcdPageMs   = 0;
unsigned long lastTelemetryMs = 0;
unsigned long lastRemoteMs    = 0;
uint8_t       lcdPage         = 0;
bool          ledState        = false;

// =================================================================================
// 5. SETUP
// =================================================================================
void setup() {
  Serial.begin(115200);

  // I2C
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  pinMode(PIN_TRIG_OIL,    OUTPUT);
  pinMode(PIN_ECHO_OIL,    INPUT);
  pinMode(PIN_TRIG_POMACE, OUTPUT);
  pinMode(PIN_ECHO_POMACE, INPUT);
  pinMode(PIN_PUMP_RELAY,  OUTPUT);
  pinMode(PIN_STATUS_LED,  OUTPUT);

  pinMode(PIN_BOWL_IN1,    OUTPUT);
  pinMode(PIN_BOWL_IN2,    OUTPUT);
  pinMode(PIN_SCREW_IN1,   OUTPUT);
  pinMode(PIN_SCREW_IN2,   OUTPUT);

  // LEDC PWM setup (ESP32)
  ledcSetup(BOWL_PWM_CH,   PWM_FREQ, PWM_RESOLUTION);
  ledcSetup(SCREW_PWM_CH,  PWM_FREQ, PWM_RESOLUTION);
  ledcAttachPin(PIN_BOWL_PWM,  BOWL_PWM_CH);
  ledcAttachPin(PIN_SCREW_PWM, SCREW_PWM_CH);

  digitalWrite(PIN_PUMP_RELAY, RELAY_OFF);
  ledcWrite(BOWL_PWM_CH,  0);
  ledcWrite(SCREW_PWM_CH, 0);

  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0); lcd.print(F("Decanter ESP32  "));
  lcd.setCursor(0, 1); lcd.print(F("Booting...      "));

  dsSensor.begin();
  dsSensor.setWaitForConversion(false);

  lastRemoteMs    = millis();
  lastTempCycleMs = millis();
  Serial.println(F("$INFO,ESP32 firmware online,Mode=AUTO/NOMINAL*00"));
}

// =================================================================================
// 6. SENSOR READS
// =================================================================================
float readUltrasonicCm(int trigPin, int echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  long duration = pulseIn(echoPin, HIGH, 30000UL);
  if (duration == 0) return 0.0;

  float distance = (duration * SPEED_OF_SOUND_CM_US) / 2.0;
  float level    = TANK_HEIGHT_CM - distance;
  return constrain(level, OUTLET_LEVEL_MIN, OUTLET_LEVEL_MAX);
}

float readFlowKgh() {
  int   adc   = analogRead(PIN_FLOW);
  float volts = (adc / (float)ADC_RESOLUTION) * RANGE_V_MAX;
  return FLOW_MIN_KGH + (volts / RANGE_V_MAX) * (FLOW_MAX_KGH - FLOW_MIN_KGH);
}

float readACS712Amps(int analogPin) {
  unsigned long start = millis();
  unsigned long count = 0;
  float sumAbs = 0.0;
  while (millis() - start < ACS712_SAMPLE_MS) {
    int   adc   = analogRead(analogPin);
    float volts = (adc / (float)ADC_RESOLUTION) * RANGE_V_MAX;
    float amps  = (volts - ACS712_ZERO_V) / ACS712_SENSITIVITY_V_PER_A;
    sumAbs += fabs(amps);
    count++;
  }
  if (count == 0) return 0.0;
  return sumAbs / (float)count;
}

void pollFastSensors() {
  flowKgh       = readFlowKgh();
  oilLevelCm    = readUltrasonicCm(PIN_TRIG_OIL,    PIN_ECHO_OIL);
  pomaceLevelCm = readUltrasonicCm(PIN_TRIG_POMACE, PIN_ECHO_POMACE);
  bowlCurrentA  = readACS712Amps(PIN_BOWL_CURRENT);
  screwCurrentA = readACS712Amps(PIN_SCREW_CURRENT);
}

void pollTemperatureAsync(unsigned long now) {
  if (!tempConversionPending && (now - lastTempCycleMs) >= TEMP_REQUEST_MS) {
    dsSensor.requestTemperatures();
    tempRequestedAt        = now;
    tempConversionPending  = true;
  }
  if (tempConversionPending && (now - tempRequestedAt) >= TEMP_CONVERSION_MS) {
    float t = dsSensor.getTempCByIndex(0);
    if (t > -100.0 && t < 125.0) tempC = t;
    tempConversionPending = false;
    lastTempCycleMs       = now;
  }
}

// =================================================================================
// 7. DERIVED QUANTITIES
// =================================================================================
void updateDerivedMetrics() {
  float bowlPowerW  = MOTOR_SUPPLY_V * bowlCurrentA;
  float screwPowerW = MOTOR_SUPPLY_V * screwCurrentA;
  totalPowerW = bowlPowerW + screwPowerW;

  if (flowKgh > 1.0) {
    specificEnergy = (totalPowerW / 1000.0) / (flowKgh / 1000.0);
  } else {
    specificEnergy = 0.0;
  }

  float diffSpeed = bowlRpm - screwRpm;
  predictedEff = 70.0
                 + (oilLevelCm    * 1.8)
                 + (diffSpeed     * 0.25)
                 - (flowKgh       * 0.0015)
                 + ((tempC - 30.0) * 0.1);
  predictedEff = constrain(predictedEff, 0.0, 100.0);
}

// =================================================================================
// 8. CONTROL
// =================================================================================
void applyPumpControl() {
  if (pumpMode == PUMP_AUTO) {
    if (pumpOn && oilLevelCm < oilLowSetpoint) {
      pumpOn = false;
    } else if (!pumpOn && oilLevelCm > oilHighSetpoint) {
      pumpOn = true;
    }
  }
  digitalWrite(PIN_PUMP_RELAY, pumpOn ? RELAY_ON : RELAY_OFF);
}

void driveMotor(int pwmCh, int in1Pin, int in2Pin, MotorDir dir,
                float rpm, float rpmMin, float rpmMax) {
  float clamped = constrain(rpm, rpmMin, rpmMax);
  int duty = map((long)clamped, (long)rpmMin, (long)rpmMax, 0, 255);

  if (dir == DIR_FWD) {
    digitalWrite(in1Pin, HIGH);
    digitalWrite(in2Pin, LOW);
  } else {
    digitalWrite(in1Pin, LOW);
    digitalWrite(in2Pin, HIGH);
  }
  ledcWrite(pwmCh, duty);
}

void applyMotorOutputs() {
  driveMotor(BOWL_PWM_CH,  PIN_BOWL_IN1,  PIN_BOWL_IN2,  bowlDir,  bowlRpm,  BOWL_RPM_MIN,  BOWL_RPM_MAX);
  driveMotor(SCREW_PWM_CH, PIN_SCREW_IN1, PIN_SCREW_IN2, screwDir, screwRpm, SCREW_RPM_MIN, SCREW_RPM_MAX);
}

void applyFeedPreset(FeedPreset preset) {
  feedMode = preset;
  switch (preset) {
    case FEED_WATERY:   bowlRpm = BOWL_WATERY;   screwRpm = SCREW_WATERY;   break;
    case FEED_THICKER:  bowlRpm = BOWL_THICKER;  screwRpm = SCREW_THICKER;  break;
    case FEED_NOMINAL:
    default:            bowlRpm = BOWL_NOMINAL;  screwRpm = SCREW_NOMINAL;  break;
  }
}

void setSpeeds(float bowl, float screw, FeedPreset preset) {
  bowlRpm  = constrain(bowl,  BOWL_RPM_MIN,  BOWL_RPM_MAX);
  screwRpm = constrain(screw, SCREW_RPM_MIN, SCREW_RPM_MAX);
  feedMode = preset;
}

void emergencyStop() {
  ledcWrite(BOWL_PWM_CH,  0);
  ledcWrite(SCREW_PWM_CH, 0);
  digitalWrite(PIN_BOWL_IN1,  LOW);
  digitalWrite(PIN_BOWL_IN2,  LOW);
  digitalWrite(PIN_SCREW_IN1, LOW);
  digitalWrite(PIN_SCREW_IN2, LOW);
  bowlRpm  = BOWL_RPM_MIN;
  screwRpm = SCREW_RPM_MIN;
}

void handleRemoteTimeout(unsigned long now) {
  if (feedMode == FEED_REMOTE && (now - lastRemoteMs) >= REMOTE_TIMEOUT) {
    applyFeedPreset(FEED_NOMINAL);
    Serial.println(F("$WARN,Remote silent; revert NOMINAL*00"));
  }
}

// =================================================================================
// 9. LCD
// =================================================================================
const char* feedModeLabel() {
  switch (feedMode) {
    case FEED_WATERY:  return "WATERY ";
    case FEED_THICKER: return "THICKER";
    case FEED_REMOTE:  return "REMOTE ";
    case FEED_NOMINAL:
    default:           return "NOMINAL";
  }
}

void padTo16(char* s) {
  int n = strlen(s);
  for (int i = n; i < 16; i++) s[i] = ' ';
  s[16] = '\0';
}

void renderLcd() {
  char row0[17];
  char row1[17];

  if (lcdPage == 0) {
    int qInt = (int)constrain(flowKgh, 0.0, 9999.0);
    snprintf(row0, sizeof(row0), "Q:%4d %s",
             qInt, pumpOn ? "PUMP ON " : "PUMP OFF");
    char oilStr[6];    dtostrf(oilLevelCm,    4, 1, oilStr);
    char pomaceStr[6]; dtostrf(pomaceLevelCm, 4, 1, pomaceStr);
    snprintf(row1, sizeof(row1), "Lo:%s Lp:%s", oilStr, pomaceStr);
  }
  else if (lcdPage == 1) {
    int b = (int)constrain(bowlRpm,  0.0, 9999.0);
    int s = (int)constrain(screwRpm, 0.0, 9999.0);
    snprintf(row0, sizeof(row0), "B:%4d S:%4d", b, s);
    char tStr[6]; dtostrf(tempC, 4, 1, tStr);
    snprintf(row1, sizeof(row1), "%s T:%sC", feedModeLabel(), tStr);
  }
  else if (lcdPage == 2) {
    char eStr[6]; dtostrf(predictedEff,   4, 1, eStr);
    char wStr[6]; dtostrf(specificEnergy, 4, 2, wStr);
    snprintf(row0, sizeof(row0), "Eta_o: %s%%", eStr);
    snprintf(row1, sizeof(row1), "E: %s kWh/t", wStr);
  }
  else {
    char biStr[6]; dtostrf(bowlCurrentA,  4, 2, biStr);
    char siStr[6]; dtostrf(screwCurrentA, 4, 2, siStr);
    snprintf(row0, sizeof(row0), "Ib:%sA", biStr);
    snprintf(row1, sizeof(row1), "Is:%sA P:%dW", siStr, (int)totalPowerW);
  }

  padTo16(row0);
  padTo16(row1);
  lcd.setCursor(0, 0); lcd.print(row0);
  lcd.setCursor(0, 1); lcd.print(row1);
}

// =================================================================================
// 10. TELEMETRY
// =================================================================================
void sendTelemetry() {
  String f = F("$DATA,");
  f += String(flowKgh, 1);        f += F(",");
  f += String(oilLevelCm, 2);     f += F(",");
  f += String(pomaceLevelCm, 2);  f += F(",");
  f += String(tempC, 2);          f += F(",");
  f += String(bowlRpm, 0);        f += F(",");
  f += String(screwRpm, 0);       f += F(",");
  f += String(bowlCurrentA, 3);   f += F(",");
  f += String(screwCurrentA, 3);  f += F(",");
  f += String(totalPowerW, 1);    f += F(",");
  f += String(specificEnergy, 2); f += F(",");
  f += String(predictedEff, 1);   f += F(",");
  f += String(pumpOn ? 1 : 0);    f += F(",");
  f += feedModeLabel();           f += F(",");
  f += (pumpMode == PUMP_AUTO ? F("AUTO") : F("MANUAL"));

  byte checksum = 0;
  for (unsigned int i = 1; i < f.length(); i++) checksum ^= f[i];

  char hex[3];
  sprintf(hex, "%02X", checksum);
  Serial.print(f);
  Serial.print('*');
  Serial.println(hex);
}

// =================================================================================
// 11. SERIAL COMMAND PARSER
// =================================================================================
void handleCommand(String& cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd.equalsIgnoreCase("PUMP:ON")) {
    pumpMode = PUMP_MANUAL; pumpOn = true;
    Serial.println(F("$ACK,Manual pump ON*00"));
  }
  else if (cmd.equalsIgnoreCase("PUMP:OFF")) {
    pumpMode = PUMP_MANUAL; pumpOn = false;
    Serial.println(F("$ACK,Manual pump OFF*00"));
  }
  else if (cmd.equalsIgnoreCase("AUTO")) {
    pumpMode = PUMP_AUTO;
    Serial.println(F("$ACK,Auto pump hysteresis*00"));
  }
  else if (cmd.equalsIgnoreCase("STOP")) {
    emergencyStop();
    Serial.println(F("$ACK,Motors stopped*00"));
  }
  else if (cmd.startsWith("SET:")) {
    int comma = cmd.indexOf(',');
    if (comma > 4) {
      float bowl  = cmd.substring(4, comma).toFloat();
      float screw = cmd.substring(comma + 1).toFloat();
      setSpeeds(bowl, screw, FEED_REMOTE);
      lastRemoteMs = millis();
      Serial.print(F("$ACK,Speeds Bowl="));
      Serial.print(bowlRpm, 0);
      Serial.print(F(" Screw="));
      Serial.print(screwRpm, 0);
      Serial.println(F("*00"));
    } else {
      Serial.println(F("$ERROR,SET expects bowl,screw*00"));
    }
  }
  else if (cmd.startsWith("FEED:")) {
    String name = cmd.substring(5);
    if      (name.equalsIgnoreCase("WATERY"))  applyFeedPreset(FEED_WATERY);
    else if (name.equalsIgnoreCase("THICKER")) applyFeedPreset(FEED_THICKER);
    else if (name.equalsIgnoreCase("NOMINAL")) applyFeedPreset(FEED_NOMINAL);
    else { Serial.println(F("$ERROR,Unknown feed preset*00")); return; }
    Serial.print(F("$ACK,Feed preset "));
    Serial.print(feedModeLabel());
    Serial.println(F("*00"));
  }
  else if (cmd.startsWith("DIR:")) {
    int comma = cmd.indexOf(',');
    if (comma > 4) {
      String motor  = cmd.substring(4, comma);
      String dirStr = cmd.substring(comma + 1);
      MotorDir d = dirStr.equalsIgnoreCase("REV") ? DIR_REV : DIR_FWD;
      if      (motor.equalsIgnoreCase("BOWL"))  bowlDir  = d;
      else if (motor.equalsIgnoreCase("SCREW")) screwDir = d;
      else { Serial.println(F("$ERROR,DIR expects BOWL/SCREW*00")); return; }
      Serial.print(F("$ACK,Direction "));
      Serial.print(motor);
      Serial.print(F("="));
      Serial.print(d == DIR_FWD ? F("FWD") : F("REV"));
      Serial.println(F("*00"));
    } else {
      Serial.println(F("$ERROR,DIR expects motor,dir*00"));
    }
  }
  else if (cmd.startsWith("LEVEL:")) {
    int comma = cmd.indexOf(',');
    if (comma > 6) {
      float lo = cmd.substring(6, comma).toFloat();
      float hi = cmd.substring(comma + 1).toFloat();
      if (hi > lo && lo >= 0.0 && hi <= TANK_HEIGHT_CM) {
        oilLowSetpoint  = lo;
        oilHighSetpoint = hi;
        Serial.print(F("$ACK,Hysteresis LOW="));
        Serial.print(oilLowSetpoint, 1);
        Serial.print(F(" HIGH="));
        Serial.print(oilHighSetpoint, 1);
        Serial.println(F("*00"));
      } else {
        Serial.println(F("$ERROR,Bad LEVEL range*00"));
      }
    }
  }
  else {
    Serial.println(F("$ERROR,Unrecognized*00"));
  }
}

void processSerial() {
  static String buf = "";
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      handleCommand(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
}

// =================================================================================
// 12. MAIN LOOP
// =================================================================================
void loop() {
  unsigned long now = millis();

  processSerial();
  pollTemperatureAsync(now);

  if (now - lastSensorMs >= SENSOR_INTERVAL) {
    lastSensorMs = now;
    pollFastSensors();
    applyPumpControl();
    handleRemoteTimeout(now);
    applyMotorOutputs();
    updateDerivedMetrics();

    ledState = !ledState;
    digitalWrite(PIN_STATUS_LED, ledState);
  }

  if (now - lastLcdPageMs >= LCD_PAGE_INTERVAL) {
    lastLcdPageMs = now;
    lcdPage = (lcdPage + 1) % 4;
  }
  if (now - lastLcdMs >= LCD_INTERVAL) {
    lastLcdMs = now;
    renderLcd();
  }

  if (now - lastTelemetryMs >= TELEMETRY_INTERVAL) {
    lastTelemetryMs = now;
    sendTelemetry();
  }
}
