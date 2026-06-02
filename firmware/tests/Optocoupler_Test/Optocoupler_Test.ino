// Define the PWM pin connected to the Optocoupler's Anode
#include <Arduino.h>
const int OPTO_PIN = 9; 

void setup() {
  pinMode(OPTO_PIN, OUTPUT);
  
  // Start the serial monitor at 9600 baud
  Serial.begin(9600);
  
  // Set an initial state (0 = LED off, max LDR resistance)
  analogWrite(OPTO_PIN, 0);
  
  Serial.println("--- Optocoupler Interactive Terminal ---");
  Serial.println("Type a PWM value between 0 and 255 and hit Enter.");
  Serial.println("0   = LED Off (Max Resistance)");
  Serial.println("255 = LED Max (Min Resistance)");
  Serial.println("----------------------------------------");
}

void loop() {
  // Check if you have typed something into the terminal
  if (Serial.available() > 0) {
    
    // Read the integer you typed
    int incomingValue = Serial.parseInt();
    
    // Clear out any invisible newline characters left in the buffer
    while(Serial.available() > 0) {
      Serial.read();
    }
    
    // Protect the hardware: Force the number to stay within 0-255
    int safePwm = constrain(incomingValue, 0, 255);
    
    // Fire the command to the hardware
    analogWrite(OPTO_PIN, safePwm);
    
    // Confirm the action on the screen
    Serial.print(">> Hardware Updated. PWM set to: ");
    Serial.println(safePwm);
  }
}