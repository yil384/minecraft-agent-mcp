# the evidence of a change of the spot over the shoulder (agentcam:shoulder)
scoreboard players operation #rl agentcam_y = #sr agentcam_y
scoreboard players operation #sl agentcam_y = #sr agentcam_y
scoreboard players set #nc agentcam_y 100
function agentcam:note_new
