/**
 * =================================================================================
 *          DECANTER CENTRIFUGE BENCH FIRMWARE  (decanterCentrifuge/twin bridge)
 * ---------------------------------------------------------------------------------
 * Target Hardware: Arduino Mega 2560
 *
 * PHYSICAL HARDWARE:
 *   - 1x Analog 0-5V flow rate transmitter   -> A0      (FLOW_MAX_KGH at 5 V)
 *   - 1x ACS712 (20 A) current sensor        -> A1      Bowl motor line
 *   - 1x ACS712 (20 A) current sensor        -> A2      Screw motor line
 *   - 1x DS18B20 temperature sensor (1-Wire) -> D5      with 4k7 pull-up to +5 V
 *   - 2x HC-SR04 ultrasonic sensors          -> D22/D23 (oil outlet)
 *                                                D24/D25 (pomace outlet)
 *   - 1x Relay module (pump on/off)          -> D7      (active LOW)
 *   - 1x L298N dual H-bridge motor driver    -> Bowl  : ENA=D9,  IN1=D26, IN2=D27
 *                                                Screw : ENB=D10, IN3=D28, IN4=D29
 *   - 1x I2C 16x2 LCD (PCF8574 backpack)     -> SDA=D20, SCL=D21
 *   - Built-in status LED                    -> D13
 *
 * BEHAVIOUR:
 *   - Polls flow + ultrasonics + currents every 250 ms.
 *   - Polls DS18B20 asynchronously (~750 ms conversion) without blocking the loop.
 *   - Computes measured power per motor (V_supply x I_measured for DC bench drive)
 *     and specific energy consumption (kWh per tonne).
 *   - Predicts oil recovery (eta_o) from the oil-outlet ring height, differential
 *     speed, flow rate and feed temperature.
 *   - Drives pump via hysteresis on the oil outlet ring (auto mode).
 *   - Drives bowl + screw motors with PWM + direction.
 *   - Telemetry frame for the Next.js dashboard streamed every 2 s.
 *
 * SERIAL COMMANDS (from MATLAB or the dashboard):
 *   SET:<bowlRpm>,<screwRpm>      Direct speed setpoints
 *   FEED:WATERY|THICKER|NOMINAL   Heuristic preset (thesis rule)
 *   DIR:BOWL,FWD|REV              Bowl rotation direction
 *   DIR:SCREW,FWD|REV             Screw rotation direction
 *   PUMP:ON|OFF                   Manual pump override
 *   AUTO                          Resume hysteresis pump control
 *   LEVEL:<low>,<high>            Tune oil-ring hysteresis (cm)
 *   STOP                          Zero both motor PWMs immediately
 *
 * REQUIRED LIBRARIES (Arduino Library Manager):
 *   - LiquidCrystal_I2C  (Frank de Brabander)
 *   - OneWire            (Paul Stoffregen)
 *   - DallasTemperature  (Miles Burton)
 *
 * =================================================================================
 */

#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// =================================================================================
// 1. PIN ASSIGNMENTS
// =================================================================================
const int PIN_FLOW            = A0;
const int PIN_BOWL_CURRENT    = A1;
const int PIN_SCREW_CURRENT   = A2;

const int PIN_DS18B20         = 5;   // 1-Wire bus

const int PIN_TRIG_OIL        = 22;
const int PIN_ECHO_OIL        = 23;
const int PIN_TRIG_POMACE     = 24;
const int PIN_ECHO_POMACE     = 25;

const int PIN_PUMP_RELAY      = 7;
const int PIN_STATUS_LED      = 13;

// L298N -- Motor A = Bowl
const int PIN_BOWL_PWM        = 9;
const int PIN_BOWL_IN1        = 26;
const int PIN_BOWL_IN2        = 27;

// L298N -- Motor B = Screw conveyor
const int PIN_SCREW_PWM       = 10;
const int PIN_SCREW_IN1       = 28;
const int PIN_SCREW_IN2       = 29;

// =================================================================================
// 2. CALIBRATION CONSTANTS
// =================================================================================
const float RANGE_V_MAX       = 5.0;
const int   ADC_RESOLUTION    = 1023;

// Flow transmitter: 0 V -> 0 kg/h, 5 V -> FLOW_MAX_KGH
const float FLOW_MIN_KGH      = 0.0;
const float FLOW_MAX_KGH      = 6000.0;

// Ultrasonic geometry
const float SPEED_OF_SOUND_CM_US = 0.0343;
const float TANK_HEIGHT_CM       = 20.0;
const float OUTLET_LEVEL_MIN     = 0.0;
const float OUTLET_LEVEL_MAX     = TANK_HEIGHT_CM;

// ACS712 20 A: 100 mV/A sensitivity, output centred at VCC/2 (2.5 V) at zero current
const float ACS712_SENSITIVITY_V_PER_A = 0.100;
const float ACS712_ZERO_V              = 2.5;
const unsigned long ACS712_SAMPLE_MS   = 30;   // averaging window per channel

// DC motor supply -- set to the actual voltage on the L298N +12V rail.
const float MOTOR_SUPPLY_V    = 12.0;

// Relay polarity (most blue relay modules are active LOW)
const uint8_t RELAY_ON  = LOW;
const uint8_t RELAY_OFF = HIGH;

// Motor speed envelopes (rpm). PWM 0-255 is mapped linearly across these.
const float BOWL_RPM_MIN      = 2500.0;
const float BOWL_RPM_MAX      = 4000.0;
const float SCREW_RPM_MIN     = 2470.0;
const float SCREW_RPM_MAX     = 3990.0;

// Thesis heuristic presets
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
const unsigned long TEMP_REQUEST_MS    = 2000;   // request a new conversion every 2 s
const unsigned long TEMP_CONVERSION_MS = 800;    // 12-bit DS18B20 conversion budget

// =================================================================================
// 4. STATE
// =================================================================================
LiquidCrystal_I2C lcd(0x27, 16, 2);    // change to 0x3F if your backpack uses that
OneWire oneWire(PIN_DS18B20);
DallasTemperature dsSensor(&oneWire);

float flowKgh        = 0.0;
float oilLevelCm     = 0.0;
float pomaceLevelCm  = 0.0;
float tempC          = 25.0;       // last good reading
float bowlCurrentA   = 0.0;
float screwCurrentA  = 0.0;
float totalPowerW    = 0.0;
float specificEnergy = 0.0;        // kWh / t
float predictedEff   = 0.0;        // % oil recovery
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

// DS18B20 async state machine
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

  pinMode(PIN_TRIG_OIL,    OUTPUT);
  pinMode(PIN_ECHO_OIL,    INPUT);
  pinMode(PIN_TRIG_POMACE, OUTPUT);
  pinMode(PIN_ECHO_POMACE, INPUT);
  pinMode(PIN_PUMP_RELAY,  OUTPUT);
  pinMode(PIN_STATUS_LED,  OUTPUT);

  pinMode(PIN_BOWL_PWM,    OUTPUT);
  pinMode(PIN_BOWL_IN1,    OUTPUT);
  pinMode(PIN_BOWL_IN2,    OUTPUT);
  pinMode(PIN_SCREW_PWM,   OUTPUT);
  pinMode(PIN_SCREW_IN1,   OUTPUT);
  pinMode(PIN_SCREW_IN2,   OUTPUT);

  digitalWrite(PIN_PUMP_RELAY, RELAY_OFF);
  analogWrite(PIN_BOWL_PWM,  0);
  analogWrite(PIN_SCREW_PWM, 0);

  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0); lcd.print(F("Decanter Bench  "));
  lcd.setCursor(0, 1); lcd.print(F("Booting...      "));

  dsSensor.begin();
  dsSensor.setWaitForConversion(false);   // async; we poll the timer ourselves

  lastRemoteMs   = millis();
  lastTempCycleMs = millis();
  Serial.println(F("$INFO,Bench firmware online,Mode=AUTO/NOMINAL*00"));
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

// Averages |I| over ACS712_SAMPLE_MS to smooth PWM ripple; works for DC and chopped DC.
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

// Non-blocking DS18B20: kick a conversion, then read the result ~750 ms later.
void pollTemperatureAsync(unsigned long now) {
  if (!tempConversionPending && (now - lastTempCycleMs) >= TEMP_REQUEST_MS) {
    dsSensor.requestTemperatures();
    tempRequestedAt        = now;
    tempConversionPending  = true;
  }
  if (tempConversionPending && (now - tempRequestedAt) >= TEMP_CONVERSION_MS) {
    float t = dsSensor.getTempCByIndex(0);
    if (t > -100.0 && t < 125.0) tempC = t;   // ignore disconnected-sensor sentinels
    tempConversionPending = false;
    lastTempCycleMs       = now;
  }
}

// =================================================================================
// 7. DERIVED QUANTITIES
// =================================================================================
void updateDerivedMetrics() {
  // Measured electrical power on the bench DC drive
  float bowlPowerW  = MOTOR_SUPPLY_V * bowlCurrentA;
  float screwPowerW = MOTOR_SUPPLY_V * screwCurrentA;
  totalPowerW = bowlPowerW + screwPowerW;

  // Specific energy consumption (kWh per tonne of feed)
  if (flowKgh > 1.0) {
    specificEnergy = (totalPowerW / 1000.0) / (flowKgh / 1000.0);   // = W / kg/h
  } else {
    specificEnergy = 0.0;
  }

  // Predicted oil recovery using only the signals we actually measure.
  // - Higher oil-ring height -> more recovery
  // - Higher diff speed     -> better conveying / clearer phase split
  // - Higher feed flow      -> shorter residence time -> recovery drops
  // - Higher feed temp      -> lower viscosity        -> recovery rises
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

void driveMotor(int pwmPin, int in1Pin, int in2Pin, MotorDir dir,
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
  analogWrite(pwmPin, duty);
}

void applyMotorOutputs() {
  driveMotor(PIN_BOWL_PWM,  PIN_BOWL_IN1,  PIN_BOWL_IN2,  bowlDir,  bowlRpm,  BOWL_RPM_MIN,  BOWL_RPM_MAX);
  driveMotor(PIN_SCREW_PWM, PIN_SCREW_IN1, PIN_SCREW_IN2, screwDir, screwRpm, SCREW_RPM_MIN, SCREW_RPM_MAX);
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
  analogWrite(PIN_BOWL_PWM,  0);
  analogWrite(PIN_SCREW_PWM, 0);
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
    Serial.println(F("$WARN,Remote silent; reverting to NOMINAL preset*00"));
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
// 10. TELEMETRY (consumed by the Next.js dashboard via Web Serial)
// =================================================================================
void sendTelemetry() {
  // $DATA,Flow,OilLvl,PomLvl,TempC,BowlRpm,ScrewRpm,BowlI,ScrewI,PowerW,EkWhPerT,
  //       PredEff,PumpState,FeedMode,PumpMode*XX
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
      else { Serial.println(F("$ERROR,DIR expects BOWL or SCREW*00")); return; }
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
    Serial.println(F("$ERROR,Command unrecognized*00"));
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
