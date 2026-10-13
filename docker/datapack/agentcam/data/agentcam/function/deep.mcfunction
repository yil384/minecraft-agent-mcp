# sealed in with no spot outside (under rock): the camera sees through the bot's own eyes (agentcam:view); a spot is
# looked for again every 2 s
scoreboard players add #hold agentcam_y 1
execute if score #hold agentcam_y matches 40.. run scoreboard players set #on agentcam_y 0
