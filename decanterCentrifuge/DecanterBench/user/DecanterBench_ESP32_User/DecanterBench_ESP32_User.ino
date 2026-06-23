/**
 * =================================================================================
 *  DECANTER CENTRIFUGE FIRMWARE — YOUR ESP32 HARDWARE
 * ---------------------------------------------------------------------------------
 * Target: ESP32 (your system)
 *
 * HARDWARE CONNECTIONS:
 *   HC-SR04 (oil tank level)           Trig=GPIO18, Echo=GPIO19
 *   LCD I2C (16x2, PCF8574)            SDA=GPIO21, SCL=GPIO22
 *   2-Ch Relay module                  IN1=GPIO33 (bowl motor ON/OFF)
 *                                       IN2=GPIO4  (pump / spare)
 *   ACS712 (bowl motor current)        GPIO35 (ADC1_CH7)
 *   L298N (screw/conveyer motor)       ENA=GPIO25 (PWM speed)
 *                                       IN1=GPIO26, IN2=GPIO27
 *   YF-S201 / Hall-effect flow meter   GPIO32  (pulse input, interrupt)
 *   DS18B20 temperature sensor         GPIO5   (1-Wire, 4k7 pull-up)
 *   Buzzer                              GPIO23
 *   Status LED (built-in)              GPIO2
 *
 * HOW IT WORKS:
 *   - Bowl motor    → relay ON/OFF (high current 12V DC motor)
 *   - Screw motor   → L298N PWM speed control (lower current DC motor)
 *   - ACS712        → measures bowl motor current draw
 *   - Flow meter    → pulse counting via interrupt
 *
 * The screw speed is varied to control differential speed.
 * Bowl runs at fixed nominal speed when relay is ON.
 *
 * TELEMETRY: $DATA frame every 2 s, same format as dashboard expects.
 * COMMANDS:  SET:<bowlRPM>,<screwRPM> | FEED:WATERY|THICKER|NOMINAL
 *            PUMP:ON|OFF | AUTO | STOP | DIR:BOWL|SCREW,FWD|REV | LEVEL:lo,hi
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
// 1. PIN ASSIGNMENTS  (YOUR hardware)
// =================================================================================
// HC-SR04
const int PIN_TRIG_OIL   = 18;
const int PIN_ECHO_OIL   = 19;

// I2C LCD
const int PIN_I2C_SDA    = 21;
const int PIN_I2C_SCL    = 22;

// 2-Ch Relay: IN1 = bowl motor ON/OFF, IN2 = pump (or spare)
const int PIN_BOWL_RELAY = 33;
const int PIN_PUMP_RELAY = 4;

// ACS712 bowl motor current
const int PIN_BOWL_CURRENT = 35;  // ADC1_CH7

// L298N — screw/conveyer motor
const int PIN_SCREW_PWM  = 25;
const int PIN_SCREW_IN1  = 26;
const int PIN_SCREW_IN2  = 27;

// Flow meter (pulse output)
const int PIN_FLOW       = 32;

// DS18B20
const int PIN_DS18B20    = 5;

// Buzzer
const int PIN_BUZZER     = 23;

// Status LED
const int PIN_STATUS_LED = 2;

// PWM for screw motor — software PWM (works on all ESP32 core versions)
const int SCREW_PWM_PERIOD_US = 2000;  // 500 Hz

// =================================================================================
// 2. CALIBRATION CONSTANTS
// =================================================================================
// ACS712 20 A: 100 mV/A, centred at VCC/2 (2.5 V)
const float ACS712_SENSITIVITY_V_PER_A = 0.100;
const float ACS712_ZERO_V              = 2.5;
const unsigned long ACS712_SAMPLE_MS   = 30;

// Flow meter: pulse frequency → flow rate
// YF-S801 etc: flow_Lmin = Hz / 7.5.  Adjust this factor to match your sensor.
const float FLOW_PULSES_PER_LITRE      = 450.0;  // pulses per litre (YF-S201 ≈ 450)
const float FLOW_L_TO_KG               = 1.15;   // olive paste density ~1.15 kg/L

// Bowl motor: nominal speed when relay is ON
const float BOWL_NOMINAL_RPM    = 3000.0;
const float BOWL_RPM_MIN        = 2500.0;   // lower bound for display/reference
const float BOWL_RPM_MAX        = 4000.0;

// Screw motor speed envelope (RPM at motor shaft, mapped from PWM)
const float SCREW_RPM_MIN       = 2470.0;
const float SCREW_RPM_MAX       = 3990.0;
const float SCREW_NOMINAL_RPM   = 2985.0;

// Heuristic presets (thesis-based)
const float BOWL_WATERY         = 2700.0;
const float SCREW_WATERY        = 2680.0;
const float BOWL_THICKER        = 3300.0;
const float SCREW_THICKER       = 3288.0;

// Motor supply voltage for power calculation
const float MOTOR_SUPPLY_V      = 12.0;

// Ultrasonic geometry
const float SPEED_OF_SOUND_CM_US = 0.0343;
const float TANK_HEIGHT_CM       = 20.0;
const float OUTLET_LEVEL_MIN     = 0.0;
const float OUTLET_LEVEL_MAX     = TANK_HEIGHT_CM;

// Pump hysteresis (cm)
float oilLowSetpoint  = 4.0;
float oilHighSetpoint = 8.0;

// Relay polarity — try HIGH if your module doesn't click on LOW
const uint8_t RELAY_ON  = HIGH;
const uint8_t RELAY_OFF = LOW;

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
const unsigned long FLOW_PULSE_INTERVAL = 2000;  // count pulses over 2 s

// =================================================================================
// 4. STATE
// =================================================================================
LiquidCrystal_I2C lcd(0x27, 16, 2);
OneWire oneWire(PIN_DS18B20);
DallasTemperature dsSensor(&oneWire);

// Flow pulse counting
volatile unsigned long flowPulseCount  = 0;
unsigned long          lastFlowCalcMs  = 0;
unsigned long          flowPulseAccum  = 0;
float flowKgh        = 0.0;
float flowLmin       = 0.0;

float oilLevelCm     = 0.0;
float pomaceLevelCm  = 0.0;  // only one HC-SR04, so pomace is optional
float tempC          = 25.0;
float bowlCurrentA   = 0.0;
float screwCurrentA  = 0.0;  // estimated from PWM duty
float totalPowerW    = 0.0;
float specificEnergy = 0.0;
float predictedEff   = 0.0;
bool  pumpOn         = false;
bool  bowlOn         = true;

enum PumpMode   { PUMP_AUTO, PUMP_MANUAL };
enum MotorDir   { DIR_FWD, DIR_REV };
enum FeedPreset { FEED_NOMINAL, FEED_WATERY, FEED_THICKER, FEED_REMOTE };

PumpMode   pumpMode  = PUMP_AUTO;
MotorDir   screwDir  = DIR_FWD;
FeedPreset feedMode  = FEED_NOMINAL;

float bowlRpm  = BOWL_NOMINAL_RPM;   // reported bowl speed
float screwRpm = SCREW_NOMINAL_RPM;  // target screw speed

// DS18B20 async
bool          tempConversionPending = false;
unsigned long tempRequestedAt       = 0;
unsigned long lastTempCycleMs       = 0;

unsigned long lastSensorMs    = 0;
unsigned long lastLcdMs       = 0;
unsigned long lastLcdPageMs   = 0;
int           screwPwmDuty    = 0;
unsigned long screwPwmLastUs  = 0;
bool          screwPwmState   = false;
unsigned long lastTelemetryMs = 0;
unsigned long lastRemoteMs    = 0;
uint8_t       lcdPage         = 0;
bool          ledState        = false;
char          lastCmd[24]     = "";
unsigned long lastCmdMs       = 0;
const unsigned long CMD_DISPLAY_MS = 2000;

// Pulse mode (bowl relay cycling)
bool          pulseMode         = false;
bool          pulseState        = false;  // true=ON phase, false=OFF phase
unsigned long pulseOnMs         = 3000;
unsigned long pulseOffMs        = 1000;
unsigned long pulseLastToggleMs = 0;

// =================================================================================
// 5. FLOW METER INTERRUPT
// =================================================================================
void IRAM_ATTR onFlowPulse() {
  flowPulseCount++;
}

// =================================================================================
// 6. SETUP
// =================================================================================
void setup() {
  Serial.begin(115200);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  pinMode(PIN_TRIG_OIL,   OUTPUT);
  pinMode(PIN_ECHO_OIL,   INPUT);
  pinMode(PIN_BOWL_RELAY, OUTPUT);
  pinMode(PIN_PUMP_RELAY, OUTPUT);
  pinMode(PIN_STATUS_LED, OUTPUT);
  pinMode(PIN_BUZZER,     OUTPUT);

  pinMode(PIN_SCREW_IN1,  OUTPUT);
  pinMode(PIN_SCREW_IN2,  OUTPUT);
  pinMode(PIN_SCREW_PWM,  OUTPUT);

  pinMode(PIN_FLOW,       INPUT_PULLUP);

  // L298N for screw motor — pinMode is enough; software PWM handles timing
  // Flow meter interrupt
  attachInterrupt(digitalPinToInterrupt(PIN_FLOW), onFlowPulse, RISING);

  // Initial state: bowl ON, pump OFF, screw OFF
  digitalWrite(PIN_BOWL_RELAY, RELAY_ON);   // bowl starts ON
  bowlOn = true;
  digitalWrite(PIN_PUMP_RELAY, RELAY_OFF);
  screwPwmDuty = 0;

  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0); lcd.print(F("Decanter ESP32 "));
  lcd.setCursor(0, 1); lcd.print(F("Your System    "));

  dsSensor.begin();
  dsSensor.setWaitForConversion(false);

  // Buzzer beep on boot
  tone(PIN_BUZZER, 2000, 100);

  screwPwmLastUs  = micros();
  screwPwmState   = false;
  lastRemoteMs    = millis();
  lastTempCycleMs = millis();
  lastFlowCalcMs  = millis();
  Serial.println(F("$INFO,ESP32 firmware online (your hardware)*00"));
}

// =================================================================================
// 7. SENSOR READS
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

float readACS712Amps(int analogPin) {
  unsigned long start = millis();
  unsigned long count = 0;
  float sumAbs = 0.0;
  while (millis() - start < ACS712_SAMPLE_MS) {
    int   adc   = analogRead(analogPin);
    float volts = (adc / 4095.0) * 3.3;
    float amps  = (volts - ACS712_ZERO_V) / ACS712_SENSITIVITY_V_PER_A;
    sumAbs += fabs(amps);
    count++;
  }
  if (count == 0) return 0.0;
  return sumAbs / (float)count;
}

void calcFlowRate() {
  noInterrupts();
  unsigned long count = flowPulseCount;
  flowPulseCount = 0;
  interrupts();

  unsigned long now = millis();
  unsigned long dt   = now - lastFlowCalcMs;
  if (dt < 500) return;
  lastFlowCalcMs = now;

  float freq = (float)count * 1000.0 / dt;  // Hz
  flowLmin = freq / (FLOW_PULSES_PER_LITRE / 60.0);
  if (flowLmin < 0.1) flowLmin = 0.0;
  flowKgh = flowLmin * FLOW_L_TO_KG * 60.0;  // L/min → kg/h
}

void pollFastSensors() {
  calcFlowRate();
  oilLevelCm   = readUltrasonicCm(PIN_TRIG_OIL, PIN_ECHO_OIL);
  bowlCurrentA = readACS712Amps(PIN_BOWL_CURRENT);
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
// 8. DERIVED QUANTITIES
// =================================================================================
void updateDerivedMetrics() {
  // Bowl power: measured current × supply voltage (when relay ON)
  float bowlPowerW  = bowlOn ? (MOTOR_SUPPLY_V * bowlCurrentA) : 0.0;

  // Screw power: estimate from PWM duty (when running)
  int duty          = (int)(((screwRpm - SCREW_RPM_MIN) / (SCREW_RPM_MAX - SCREW_RPM_MIN)) * 255.0);
  screwCurrentA     = (duty / 255.0) * 0.5;  // rough estimate: ~0.5 A at full speed
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
// 9. CONTROL
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

void setBowlRelay(bool on) {
  pulseMode = false;
  bowlOn = on;
  digitalWrite(PIN_BOWL_RELAY, on ? RELAY_ON : RELAY_OFF);
  if (!on) bowlRpm = 0;
  else     bowlRpm = BOWL_NOMINAL_RPM;
}

void driveScrewMotor(MotorDir dir, float rpm) {
  if (rpm < SCREW_RPM_MIN) {
    screwPwmDuty = 0;
    digitalWrite(PIN_SCREW_IN1, LOW);
    digitalWrite(PIN_SCREW_IN2, LOW);
    return;
  }
  float clamped = constrain(rpm, SCREW_RPM_MIN, SCREW_RPM_MAX);
  int duty = map((long)clamped, (long)SCREW_RPM_MIN, (long)SCREW_RPM_MAX, 0, 255);

  if (dir == DIR_FWD) {
    digitalWrite(PIN_SCREW_IN1, HIGH);
    digitalWrite(PIN_SCREW_IN2, LOW);
  } else {
    digitalWrite(PIN_SCREW_IN1, LOW);
    digitalWrite(PIN_SCREW_IN2, HIGH);
  }
  screwPwmDuty = duty;
}

void applyMotorOutputs() {
  if (bowlOn) {
    bowlRpm = BOWL_NOMINAL_RPM;
  }
  driveScrewMotor(screwDir, screwRpm);
}

void applyFeedPreset(FeedPreset preset) {
  feedMode = preset;
  switch (preset) {
    case FEED_WATERY:   bowlRpm = BOWL_WATERY;   screwRpm = SCREW_WATERY;   break;
    case FEED_THICKER:  bowlRpm = BOWL_THICKER;  screwRpm = SCREW_THICKER;  break;
    case FEED_NOMINAL:
    default:            bowlRpm = BOWL_NOMINAL_RPM; screwRpm = SCREW_NOMINAL_RPM; break;
  }
  // Bowl speed presets are reference values; actual bowl speed is fixed when relay is ON
  // Screw speed is controllable via PWM
}

void setSpeeds(float bowl, float screw, FeedPreset preset) {
  bowlRpm  = constrain(bowl,  BOWL_RPM_MIN,  BOWL_RPM_MAX);
  screwRpm = constrain(screw, SCREW_RPM_MIN, SCREW_RPM_MAX);
  feedMode = preset;
  // bowlRpm here is a reference/display value; actual bowl is relay-controlled
}

void emergencyStop() {
  pulseMode = false;
  screwPwmDuty = 0;
  digitalWrite(PIN_SCREW_IN1, LOW);
  digitalWrite(PIN_SCREW_IN2, LOW);
  setBowlRelay(false);
  digitalWrite(PIN_PUMP_RELAY, RELAY_OFF);
  pumpOn = false;
  bowlRpm  = 0;
  screwRpm = 0;
  tone(PIN_BUZZER, 3000, 200);  // alert beep
}

void beginPulse(unsigned long onMs, unsigned long offMs) {
  pulseMode = true;
  pulseOnMs = onMs;
  pulseOffMs = offMs;
  pulseState = true;
  pulseLastToggleMs = millis();
  setBowlRelay(true);
}

void processPulseMode() {
  if (!pulseMode) return;
  unsigned long now = millis();
  unsigned long phaseDuration = pulseState ? pulseOnMs : pulseOffMs;
  if (now - pulseLastToggleMs >= phaseDuration) {
    pulseState = !pulseState;
    pulseLastToggleMs = now;
    setBowlRelay(pulseState);
  }
}

void checkUltrasonicAlert() {
  static unsigned long lastAlertMs = 0;
  unsigned long now = millis();
  if (oilLevelCm > 0 && oilLevelCm < oilLowSetpoint && (now - lastAlertMs) >= 2000) {
    lastAlertMs = now;
    tone(PIN_BUZZER, 2000, 100);
  }
}

// Software PWM for screw motor — works on ALL ESP32 core versions
void updateScrewPwm() {
  if (screwPwmDuty == 0) {
    digitalWrite(PIN_SCREW_PWM, LOW);
    screwPwmState = false;
    return;
  }
  if (screwPwmDuty >= 255) {
    digitalWrite(PIN_SCREW_PWM, HIGH);
    screwPwmState = true;
    return;
  }
  unsigned long now = micros();
  unsigned long onTime  = ((unsigned long)screwPwmDuty * SCREW_PWM_PERIOD_US) / 255;
  unsigned long offTime = SCREW_PWM_PERIOD_US - onTime;
  if (screwPwmState && (now - screwPwmLastUs) >= onTime) {
    digitalWrite(PIN_SCREW_PWM, LOW);
    screwPwmLastUs = now;
    screwPwmState = false;
  } else if (!screwPwmState && (now - screwPwmLastUs) >= offTime) {
    digitalWrite(PIN_SCREW_PWM, HIGH);
    screwPwmLastUs = now;
    screwPwmState = true;
  }
}

void handleRemoteTimeout(unsigned long now) {
  if (feedMode == FEED_REMOTE && (now - lastRemoteMs) >= REMOTE_TIMEOUT) {
    applyFeedPreset(FEED_NOMINAL);
    Serial.println(F("$WARN,Remote silent; revert NOMINAL*00"));
  }
}

// =================================================================================
// 10. LCD
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

  // Show last received command on LCD for 2 seconds
  if (lastCmd[0] != '\0' && (millis() - lastCmdMs) < CMD_DISPLAY_MS) {
    snprintf(row0, sizeof(row0), "CMD: %-11.11s", lastCmd);
    snprintf(row1, sizeof(row1), "B:%-4.0f S:%-4.0f", bowlRpm, screwRpm);
    padTo16(row0); padTo16(row1);
    lcd.setCursor(0, 0); lcd.print(row0);
    lcd.setCursor(0, 1); lcd.print(row1);
    return;
  }

  if (lcdPage == 0) {
    int qInt = (int)constrain(flowLmin, 0.0, 99.0);
    snprintf(row0, sizeof(row0), "Q:%2d %s",
             qInt, bowlOn ? "BOWL ON" : "BOWL OFF");
    char oilStr[6]; dtostrf(oilLevelCm, 4, 1, oilStr);
    snprintf(row1, sizeof(row1), "Lo:%s P:%s", oilStr, pumpOn ? "ON " : "OFF");
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
    char biStr[6]; dtostrf(bowlCurrentA, 4, 2, biStr);
    snprintf(row0, sizeof(row0), "Ib:%sA", biStr);
    snprintf(row1, sizeof(row1), "Flow: %4.1f Lpm", flowLmin);
  }

  padTo16(row0);
  padTo16(row1);
  lcd.setCursor(0, 0); lcd.print(row0);
  lcd.setCursor(0, 1); lcd.print(row1);
}

// =================================================================================
// 11. TELEMETRY  (same $DATA format, so dashboard works unchanged)
// =================================================================================
void sendTelemetry() {
  String f = F("$DATA,");
  f += String(flowKgh, 1);        f += F(",");
  f += String(oilLevelCm, 2);     f += F(",");
  f += String(0.0, 2);            f += F(",");  // pomaceLevelCm (no second sensor)
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
// 12. SERIAL COMMAND PARSER
// =================================================================================
void handleCommand(String& cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  // Store last command for LCD display
  cmd.toCharArray(lastCmd, sizeof(lastCmd));
  lastCmdMs = millis();

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
  else if (cmd.equalsIgnoreCase("BOWL:ON")) {
    setBowlRelay(true);
    Serial.println(F("$ACK,Bowl ON*00"));
  }
  else if (cmd.equalsIgnoreCase("BOWL:OFF")) {
    setBowlRelay(false);
    Serial.println(F("$ACK,Bowl OFF*00"));
  }
  else if (cmd.equalsIgnoreCase("STOP")) {
    emergencyStop();
    Serial.println(F("$ACK,EMERGENCY STOP*00"));
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
      if (motor.equalsIgnoreCase("SCREW")) screwDir = d;
      else { Serial.println(F("$ERROR,DIR expects SCREW*00")); return; }
      Serial.print(F("$ACK,Direction SCREW="));
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
  else if (cmd.startsWith("PULSE:")) {
    String params = cmd.substring(6);
    if (params.equalsIgnoreCase("OFF")) {
      pulseMode = false;
      setBowlRelay(true);
      Serial.println(F("$ACK,Pulse mode OFF*00"));
    } else {
      int comma = params.indexOf(',');
      if (comma > 0) {
        unsigned long onMs  = params.substring(0, comma).toInt();
        unsigned long offMs = params.substring(comma + 1).toInt();
        if (onMs >= 100 && offMs >= 100 && onMs <= 30000 && offMs <= 30000) {
          beginPulse(onMs, offMs);
          Serial.print(F("$ACK,Pulse ON="));
          Serial.print(onMs);
          Serial.print(F(" OFF="));
          Serial.print(offMs);
          Serial.println(F("*00"));
        } else {
          Serial.println(F("$ERROR,Pulse 100-30000ms*00"));
        }
      } else {
        Serial.println(F("$ERROR,Pulse expects ON,OFF ms*00"));
      }
    }
  }
  else if (cmd.equalsIgnoreCase("SCREW:TEST")) {
    screwDir = DIR_FWD;
    screwPwmDuty = 255;
    digitalWrite(PIN_SCREW_IN1, HIGH);
    digitalWrite(PIN_SCREW_IN2, LOW);
    screwRpm = SCREW_RPM_MAX;
    Serial.println(F("$ACK,Screw test 100% duty*00"));
  }
  else if (cmd.equalsIgnoreCase("SCREW:OFF")) {
    screwPwmDuty = 0;
    digitalWrite(PIN_SCREW_IN1, LOW);
    digitalWrite(PIN_SCREW_IN2, LOW);
    screwRpm = 0.0;
    Serial.println(F("$ACK,Screw OFF*00"));
  }
  else if (cmd.equalsIgnoreCase("BUZZER:TEST")) {
    tone(PIN_BUZZER, 2000, 150);
    Serial.println(F("$ACK,Buzzer test*00"));
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
// 13. MAIN LOOP
// =================================================================================
void loop() {
  unsigned long now = millis();

  processSerial();
  processPulseMode();
  pollTemperatureAsync(now);

  if (now - lastSensorMs >= SENSOR_INTERVAL) {
    lastSensorMs = now;
    pollFastSensors();
    applyPumpControl();
    handleRemoteTimeout(now);
    applyMotorOutputs();
    updateDerivedMetrics();
    checkUltrasonicAlert();

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

  updateScrewPwm();
}

