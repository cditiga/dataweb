const fs = require('fs');
const path = require('path');
const toml = require('toml');
const yaml = require('js-yaml');

function findConfigFile(startPath) {
  let currentPath = startPath;
  while (currentPath !== path.parse(currentPath).root) {
    const configPath = path.join(currentPath, 'config.toml');
    if (fs.existsSync(configPath)) {
      return configPath;
    }
    currentPath = path.dirname(currentPath);
  }
  return null;
}

function processSpintax(text) {
  if (typeof text !== 'string') return text;
  
  const regex = /\{([^{}]+)\}/g;
  let result = text;
  let match;

  while ((match = regex.exec(result)) !== null) {
    const options = match[1].split('|');
    const replacement = options[Math.floor(Math.random() * options.length)];
    result = result.substring(0, match.index) + replacement + result.substring(match.index + match[0].length);
    regex.lastIndex = 0;
  }

  return result;
}

try {
  const configPath = findConfigFile(__dirname);
  if (!configPath) {
    throw new Error('config.toml not found in the project directory or its parent directory.');
  }

  console.log(`Using config.toml from: ${configPath}`);

  const configContent = fs.readFileSync(configPath, 'utf8');
  const config = toml.parse(configContent);

  const processedTestimonials = config.params.testimonials.map(testimonial => ({
    ...testimonial,
    name: processSpintax(testimonial.name),
    message: processSpintax(testimonial.message),
    response: processSpintax(testimonial.response)
  }));

  const data = {
    testimonials: processedTestimonials
  };

  const yamlData = yaml.dump(data);

  const yamlPath = path.join(path.dirname(configPath), 'data', 'testimonials.yaml');
  fs.writeFileSync(yamlPath, yamlData);

  console.log('Testimonials processed and YAML file created successfully!');
  
  console.log('Example of processing results:');
  console.log(processedTestimonials[0].message);
} catch (error) {
  console.error('There is an error:', error.message);
  process.exit(1);
}